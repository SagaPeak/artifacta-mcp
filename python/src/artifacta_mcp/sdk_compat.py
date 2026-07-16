"""Runtime SDK compatibility check.

The dependency floor in `pyproject.toml` (`artifacta-cli>=0.3.0,<2.0.0`)
is the primary defense — pip's resolver refuses to install this MCP
package against an SDK that lacks the surface we need. This module is
the second line of defense: if the floor is somehow bypassed (vendor
override, monorepo `pip install -e` of an old branch, dependency
resolver edge case, manual override), the server still refuses to start
with a clear, actionable error instead of crashing at first tool call
with a confusing `AttributeError` or `TypeError`.

The check introspects the real installed `Client` class and its `push`
signature rather than comparing version strings — capability is the
truer contract than the version label, and fork installs or pins with
non-standard version strings still surface correctly.
"""
from __future__ import annotations

import inspect
from collections.abc import Iterable

# Methods the MCP tools call on `artifacta.Client`. The list pins the SDK
# surface this MCP server depends on. Adding a tool that calls a new
# SDK method? Add the method name here AND bump the SDK floor in
# pyproject.toml.
REQUIRED_CLIENT_METHODS: tuple[str, ...] = (
    "whoami",
    "push",
    "get",
    "delete",
    "create_link",
    "list_sessions",
    "seal_session",
    "request_upload_url",
    "complete_upload",
)

# Keyword arguments the MCP store_artifact handler passes to Client.push().
# These are capability-checked rather than tied to an unreleased version floor.
# Missing parameters raise TypeError before any byte reaches the wire.
REQUIRED_PUSH_KWARGS: tuple[str, ...] = (
    "content",
    "filename",
    "content_type",
    "transcript",
)

_UPGRADE_HINT = (
    "Upgrade with: pip install --upgrade 'artifacta-cli>=0.3.0,<2.0.0' "
    "(or, if pipx-installed: pipx upgrade artifacta-mcp)"
)


def _missing(required: Iterable[str], present: Iterable[str]) -> list[str]:
    present_set = set(present)
    return [name for name in required if name not in present_set]


def check_sdk_compatibility(client_cls: type) -> str | None:
    """Return a human-readable error message if `client_cls` lacks the
    required surface, or None if everything looks good.

    `client_cls` is the imported `artifacta.Client` class — passed in
    rather than imported here so tests can substitute a stub.
    """
    missing_methods = _missing(
        REQUIRED_CLIENT_METHODS,
        (name for name in dir(client_cls) if not name.startswith("_")),
    )
    if missing_methods:
        return (
            f"[artifacta-mcp] refusing to start: installed artifacta-cli is missing "
            f"required Client method(s): {', '.join(missing_methods)}. "
            f"{_UPGRADE_HINT}."
        )

    try:
        push_sig = inspect.signature(client_cls.push)
    except (TypeError, ValueError) as exc:
        return (
            f"[artifacta-mcp] refusing to start: cannot introspect Client.push "
            f"signature: {exc}. {_UPGRADE_HINT}."
        )

    missing_kwargs = _missing(REQUIRED_PUSH_KWARGS, push_sig.parameters.keys())
    if missing_kwargs:
        return (
            f"[artifacta-mcp] refusing to start: installed artifacta-cli's Client.push() "
            f"is missing required parameter(s): {', '.join(missing_kwargs)}. "
            f"{_UPGRADE_HINT}."
        )

    return None
