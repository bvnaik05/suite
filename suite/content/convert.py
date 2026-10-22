"""Run a product's Node converter, which turns an old document into a collaborative one.

The child runs through the checker's `ask` (suite.content.checker), with its empty environment, heap
limit and timeout, and it can't read files other than its bundle, write files or start processes.

Unlike the checker, the converter bundles jsdom, so the child can load Node's network modules. It
drops fetch, WebSocket, EventSource and XMLHttpRequest before it reads its input, and the editor
parses old HTML into a document that loads nothing, which test_converter checks against the built
bundle with a listening socket. This guards against network use by mistake, not against a
compromised child.

A bundle is used only when it holds the version the server expects, so one built before a version
bump is refused.

A conversion either converts or is refused with a reason: the converter's own (check, too_large,
unreadable-yjs), or the child's failure (child_crash, child_timeout, bad_answer). `dropped` holds
document text, the words of a pending edit or a comment's copy, so it goes only to the conversion's
record, never to a log or report.
"""

import base64
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from suite.content import capacity, checker

# The oldest Node the converter runs on, the first whose --permission is stable; CI runs it there
NODE_MIN = (22, 13)
CONVERTER_REASONS = frozenset({"check", "too_large", "unreadable-yjs"})


class ConverterChanged(Exception):
    """The bundle holds another converter version than the run expects, so the run stops."""


@dataclass(frozen=True)
class Converted:
    state: bytes = field(repr=False)
    # "yjs" or "html", the part of the old body the state was made from
    source: str
    dropped: list[dict] = field(repr=False)
    anchors: dict[str, str] = field(repr=False)
    threads: list[dict] = field(repr=False)
    # The readable copy a live tab writes for `state`
    html: str = field(repr=False)


@dataclass(frozen=True)
class Refused:
    reason: str


def bundle_ready(bundle: Path, version: str) -> bool:
    """Whether `bundle` holds converter `version`; False without Node or it, CheckerFailed if it fails."""
    answer = checker.ask(bundle, {}, minimum=NODE_MIN)
    return answer is not None and answer.get("version") == version


def convert(
    bundle: Path, version: str, legacy: dict, max_state: int = capacity.STATE_MAX
) -> Converted | Refused | None:
    """Convert the old body `legacy`; None without Node or the bundle, ConverterChanged on a new version."""
    request = {"legacy": {**legacy, "collab": legacy["collab"] or 0}, "maxState": max_state}
    try:
        answer = checker.ask(bundle, request, minimum=NODE_MIN)
    except checker.CheckerFailed as error:
        return Refused(failure_reason(error.__cause__))

    if answer is None:
        return None

    answered = answer.get("version")
    if answered != version:
        shown = checker.plain_reason(str(answered))
        raise ConverterChanged(f"the bundle answered version {shown}, not {version}")

    return read_answer(answer, max_state)


def failure_reason(error: BaseException | None) -> str:
    """Name what the child did, from the error checker.ask failed with."""
    if isinstance(error, subprocess.TimeoutExpired):
        return "child_timeout"

    if isinstance(error, ValueError):
        return "bad_answer"

    return "child_crash"


def read_answer(answer: dict, max_state: int) -> Converted | Refused:
    """Read the converter's answer, refusing as bad_answer one of another shape."""
    if answer.get("kind") == "failed" and answer.get("reason") in CONVERTER_REASONS:
        return Refused(answer["reason"])

    try:
        state = base64.b64decode(answer["state"], validate=True)
    except (KeyError, TypeError, ValueError):
        return Refused("bad_answer")

    converted = Converted(
        state,
        answer.get("from"),
        answer.get("dropped"),
        answer.get("anchors"),
        answer.get("threads"),
        answer.get("html"),
    )
    if answer.get("kind") != "converted" or not 0 < len(state) <= max_state or not is_well_formed(converted):
        return Refused("bad_answer")

    return converted


def is_well_formed(converted: Converted) -> bool:
    """Whether each part of `converted` has the type the converter writes."""
    anchors = converted.anchors
    return (
        converted.source in {"yjs", "html"}
        and is_list_of_objects(converted.dropped)
        and all(isinstance(drop.get("kind"), str) for drop in converted.dropped)
        and is_list_of_objects(converted.threads)
        and all(is_thread(thread) for thread in converted.threads)
        and isinstance(converted.html, str)
        and isinstance(anchors, dict)
        and all(isinstance(key, str) and isinstance(value, str) for key, value in anchors.items())
    )


def is_thread(thread: dict) -> bool:
    """Whether `thread` is a 2023 thread with its key, anchor and comments as the converter writes them."""
    comments = thread.get("comments")
    return (
        isinstance(thread.get("key"), str)
        and isinstance(thread.get("anchor"), str)
        and is_list_of_objects(comments)
        and all(is_comment(comment) for comment in comments)
    )


def is_comment(comment: dict) -> bool:
    """Whether `comment` has its text, author's name and time as the converter writes them."""
    time = comment.get("time")
    return (
        isinstance(comment.get("content"), str)
        and isinstance(comment.get("authorName"), str)
        and isinstance(time, int | float)
        and not isinstance(time, bool)
    )


def is_list_of_objects(value: object) -> bool:
    """Whether `value` is a list of JSON objects."""
    return isinstance(value, list) and all(isinstance(item, dict) for item in value)
