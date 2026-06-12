"""MCP tool implementations — thin wrappers over the artifacta SDK.

Each module registers exactly one tool via `safety.register_tool`. The
`register_all_tools()` entry point imports each module so its top-level
registration runs.
"""
from __future__ import annotations

from . import (
    complete_upload,
    create_download_link,
    delete_artifact,
    get_artifact,
    get_artifact_download_url,
    list_artifacts,
    list_sessions,
    request_upload_url,
    seal_session,
    store_artifact,
    whoami,
)

_MODULES = [
    whoami,
    list_artifacts,
    get_artifact,
    get_artifact_download_url,
    list_sessions,
    store_artifact,
    request_upload_url,
    complete_upload,
    create_download_link,
    delete_artifact,
    seal_session,
]


def register_all_tools() -> None:
    """Register every tool with the safety registry.

    Tools self-register at import time; this function exists so callers can
    deterministically re-register after `safety.clear_registry()` (used by
    tests).
    """
    for mod in _MODULES:
        mod.register()
