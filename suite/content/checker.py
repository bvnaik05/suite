"""Ask a product's Node checker which row breaks a document, or whether a body holds rows, with the browsers'
Yjs and the editor's schema.

Node is optional: without Node 24 or later, or without the product's built bundle, there is no
verdict and the caller keeps the document suspect. The child runs only from background jobs. It
reads rows on stdin and answers on stdout, with an empty environment, a heap limit and a timeout,
and it can't read files other than its bundle, write files or start processes.

The permission model doesn't cover the network: the child can still load Node's network modules.
The bundle has no network code on the judging path, names no Node module but node:crypto and
drops fetch and WebSocket before it reads its input, which test_checker checks against the built
bundle. This guards against network use by mistake, not against a compromised child.

On a laptop, bisecting 64 rows on the 4 MiB state the scheduler aims for peaks at about 285 MB
resident, and a 19.1 MB checkpoint passed at 560 MB before the young-space flag. Nothing bounds
the input: a compaction job can meet a larger state. A child that runs out of its 512 MB heap or
is killed for memory fails as CheckerFailed, and the document is held with an alert.
"""

import base64
import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import frappe

from suite.content.selftest import node_version

NODE_MAJOR = 24
HEAP_MB = 512
TIMEOUT_S = 120
# A reason is a few words of the error, never document text, so it stops where quoted content could start
REASON_END = re.compile(r"[^A-Za-z0-9 _.:,-]")


@dataclass
class Verdict:
    # The first row that breaks the document, -1 for the checkpoint; None when every row is fine
    index: int | None
    reason: str = ""


class CheckerFailed(Exception):
    """The child crashed, ran out of time or memory, or answered something unreadable."""


def judge(bundle: Path, checkpoint: bytes | None, rows: list[bytes]) -> Verdict | None:
    """Ask the checker which of `rows` breaks the document; None without a usable Node or bundle."""
    checkpoint_text = None
    if checkpoint:
        checkpoint_text = encoded(checkpoint)

    answer = ask(bundle, {"checkpoint": checkpoint_text, "rows": [encoded(row) for row in rows]})
    if answer is None:
        return None

    try:
        if answer["verdict"] == "clean":
            return Verdict(None)

        index = answer["index"]
        if type(index) is not int or not -1 <= index < len(rows):
            raise ValueError("the index names no row")

        return Verdict(index, plain_reason(str(answer["reason"])))
    except (ValueError, KeyError, TypeError) as error:
        raise CheckerFailed(repr(error)) from error


def covers(bundle: Path, body: bytes, rows: list[bytes]) -> bool | None:
    """Whether `body` holds every change in `rows`, by the browsers' Yjs; None without a usable Node."""
    request = {"mode": "covers", "checkpoint": encoded(body), "rows": [encoded(row) for row in rows]}
    answer = ask(bundle, request)
    if answer is None:
        return None

    covered = answer.get("covered")
    if type(covered) is not bool:
        raise CheckerFailed("the answer names no cover")

    return covered


def encoded(part: bytes) -> str:
    """Encode one part of a request in base64 text."""
    return base64.b64encode(part).decode()


def ask(bundle: Path, request: dict, minimum: tuple[int, int] = (NODE_MAJOR, 0)) -> dict | None:
    """Run `bundle` on one request and answer its reply, or None without a Node at `minimum` or the bundle."""
    if not getattr(frappe.local, "job", None):
        raise RuntimeError("the collab checker runs only in background jobs")

    node_path = usable_node(minimum)
    if not node_path or not bundle.is_file():
        return None

    try:
        completed = subprocess.run(
            node_command(node_path, bundle),
            input=json.dumps(request),
            capture_output=True,
            text=True,
            timeout=TIMEOUT_S,
            env={},
            check=True,
        )
        answer = json.loads(completed.stdout)
        if not isinstance(answer, dict):
            raise ValueError("the answer is not an object")

        return answer
    except subprocess.CalledProcessError as error:
        last_stderr_line = error.stderr.strip().rsplit("\n", 1)[-1]
        reason = plain_reason(last_stderr_line)
        raise CheckerFailed(f"exit {error.returncode}: {reason}") from error
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        raise CheckerFailed(repr(error)) from error


def node_command(node_path: str, bundle: Path) -> list[str]:
    """Build the command that runs the bundle with reads allowed only from it."""
    # Node checks the read permission against the real path
    bundle = bundle.resolve()
    return [
        node_path,
        "--permission",
        f"--allow-fs-read={bundle}",
        f"--max-old-space-size={HEAP_MB}",
        # A small young generation cuts the peak resident memory by about a third, with the same answer
        "--max-semi-space-size=1",
        str(bundle),
    ]


def plain_reason(text: str) -> str:
    """Cut `text` to its first 80 plain characters, before anything that could quote content."""
    plain_text, *_ = REASON_END.split(text, maxsplit=1)
    return plain_text[:80].strip()


def usable_node(minimum: tuple[int, int] = (NODE_MAJOR, 0)) -> str | None:
    """Return the path of a Node at version `minimum` or newer, by default one that can run the checker."""
    version = node_version()
    if not version:
        return None

    major_text, minor_text, *_ = version.lstrip("v").split(".")
    if (int(major_text), int(minor_text)) < minimum:
        return None

    return shutil.which("node")
