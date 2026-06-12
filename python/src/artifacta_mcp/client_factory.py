"""Module-level singleton for the artifacta.Client instance.

Mirrors `mcp/typescript/src/http/instance.ts` — cli.py builds the Client once
at startup from ARTIFACTA_API_KEY + ARTIFACTA_API_URL and stores it here.
Tools call `get_client()` at handler time.
"""
from __future__ import annotations

from typing import Any

_client: Any | None = None


def set_client(client: Any) -> None:
    global _client
    _client = client


def get_client() -> Any:
    if _client is None:
        raise RuntimeError(
            "Artifacta Client not initialised. "
            "Call set_client() at startup before invoking any tool."
        )
    return _client


def reset_client() -> None:
    global _client
    _client = None
