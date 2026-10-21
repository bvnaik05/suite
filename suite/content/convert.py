"""Run a product's Node converter, which turns an old document into a collaborative one.

The child runs through the checker's `ask` (suite.content.checker), with its empty environment, heap
limit and timeout, and it can't read files other than its bundle, write files or start processes.

Unlike the checker, the converter bundles jsdom, so the child can load Node's network modules. It
drops fetch, WebSocket, EventSource and XMLHttpRequest before it reads its input, and jsdom loads
no resources, which test_converter checks against the built bundle with a listening socket. This
guards against network use by mistake, not against a compromised child.

A bundle is used only when it holds the version the server expects, so one built before a version
bump is refused.
"""

from pathlib import Path

from suite.content import checker


def bundle_ready(bundle: Path, version: str) -> bool:
    """Whether `bundle` runs and holds converter `version`; False without a usable Node or the bundle."""
    answer = checker.ask(bundle, {})
    return answer is not None and answer.get("version") == version
