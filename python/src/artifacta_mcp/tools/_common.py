"""Shared helpers for tool wrappers."""
from __future__ import annotations

import json
from typing import Any

from artifacta.errors import ArtifactaError

from .. import client_factory
from ..errors import failure_from_sdk_error, translate_http_failure


def passthrough_result(payload: Any) -> dict[str, Any]:
    """Wrap an API JSON payload in the MCP CallToolResult dict shape.

    The MCP server's tool descriptions promise verbatim API JSON, so we always
    serialise the payload as a JSON text content block.
    """
    return {
        "content": [{"type": "text", "text": json.dumps(payload, default=str)}],
        "structuredContent": payload if isinstance(payload, dict) else {"data": payload},
    }


def error_result(
    exc: Exception,
    tool_name: str,
    extra_vars: dict[str, str | None] | None = None,
    ambiguous_completion: bool = False,
) -> dict[str, Any]:
    """Translate any exception raised by an SDK call into an MCP error result."""
    if isinstance(exc, ArtifactaError):
        failure = failure_from_sdk_error(exc)
    else:
        # Unknown exception — treat as a server error so the agent retries.
        from .errors_fallback import network_failure  # local import to avoid cycle

        failure = network_failure(exc)
    failure.ambiguous_completion = ambiguous_completion
    return translate_http_failure(failure, tool_name, extra_vars)


def get_client():
    """Return the singleton Client built at server startup."""
    return client_factory.get_client()
