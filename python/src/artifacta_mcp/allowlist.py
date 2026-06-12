"""Module-level singleton for the path-confinement allow-list.

Mirrors `mcp/typescript/src/path/allowlist.ts`. cli.py calls
`build_allow_list(argv)` once at startup, then stores the resolved roots
via `set_allow_roots`. The store_artifact path branch reads them with
`get_allow_roots()` at handler time.
"""
from __future__ import annotations

_roots: list[str] | None = None


def set_allow_roots(roots: list[str]) -> None:
    global _roots
    _roots = list(roots)


def get_allow_roots() -> list[str]:
    if _roots is None:
        raise RuntimeError(
            "Path allow-list not initialised. Call set_allow_roots() at startup "
            "before invoking path-based tools."
        )
    return _roots


def reset_allow_roots() -> None:
    global _roots
    _roots = None
