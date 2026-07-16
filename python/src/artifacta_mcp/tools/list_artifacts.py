"""list_artifacts tool — plan §2.2."""
from __future__ import annotations

from typing import Any

from ..safety import ToolRegistration, register_tool
from ._common import error_result, get_client, passthrough_result

LIST_ARTIFACTS_DESCRIPTION = (
    "List artifacts owned by the calling tenant, newest first. Supports filters "
    "by `session_id`, `agent_id`, `filename` (exact match), `content_type`, "
    "`created_after` / `created_before` (ISO 8601), and one or more "
    "`metadata.<key>=<value>` pairs (multi-key requires Pro). Returns a page of "
    "artifact records and a `next_cursor` to fetch the next page. Use this to "
    "discover what an agent or pipeline produced when you only know a session or "
    "agent ID."
)

METADATA_KEY_PATTERN = r"^[a-zA-Z][a-zA-Z0-9_-]{0,63}$"
LIST_LIMIT_DEFAULT = 50

INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "session_id": {"type": "string"},
        "agent_id": {"type": "string"},
        "filename": {"type": "string"},
        "content_type": {"type": "string"},
        "created_after": {"type": "string", "format": "date-time"},
        "created_before": {"type": "string", "format": "date-time"},
        "transcript": {
            "type": "boolean",
            "default": False,
            "description": (
                'Filters for transcript artifacts by adding metadata.type="transcript" '
                "unless metadata.type is explicitly provided."
            ),
        },
        "metadata": {
            "type": "object",
            "patternProperties": {METADATA_KEY_PATTERN: {"type": "string"}},
            "additionalProperties": False,
        },
        "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 200,
            "default": LIST_LIMIT_DEFAULT,
        },
        "cursor": {
            "type": "string",
            "description": "Opaque cursor from previous page's next_cursor.",
        },
    },
    "required": [],
    "additionalProperties": False,
}

_FORWARD_STRING_KEYS = (
    "session_id",
    "agent_id",
    "filename",
    "content_type",
    "created_after",
    "created_before",
    "cursor",
)


def build_params(args: dict[str, Any] | None) -> dict[str, Any]:
    a = args or {}
    params: dict[str, Any] = {}
    for key in _FORWARD_STRING_KEYS:
        v = a.get(key)
        if isinstance(v, str):
            params[key] = v
    limit = a.get("limit")
    params["limit"] = int(limit) if isinstance(limit, int) else LIST_LIMIT_DEFAULT
    metadata = dict(a["metadata"]) if isinstance(a.get("metadata"), dict) else {}
    if a.get("transcript") is True and "type" not in metadata:
        metadata["type"] = "transcript"
    if metadata:
        for k, v in metadata.items():
            params[f"metadata.{k}"] = str(v)
    return params


def _local_invalid_request(message: str) -> dict[str, Any]:
    return {
        "isError": True,
        "content": [
            {
                "type": "text",
                "text": f"Bad arguments: {message}. Adjust the inputs and call again.",
            }
        ],
        "_meta": {"code": "invalid_request", "status": 400, "retry_hint": "do_not_retry"},
    }


async def handler(args: dict[str, Any] | None, _ctx) -> dict[str, Any]:
    if args is not None and "transcript" in args and not isinstance(args["transcript"], bool):
        return _local_invalid_request("`transcript` must be a boolean")
    client = get_client()
    params = build_params(args)
    try:
        resp = client._request("GET", "/v1/artifacts", params=params)
        body = resp.json()
    except Exception as exc:
        return error_result(exc, "list_artifacts")
    return passthrough_result(body)


def register() -> None:
    register_tool(
        ToolRegistration(
            name="list_artifacts",
            description=LIST_ARTIFACTS_DESCRIPTION,
            input_schema=INPUT_SCHEMA,
            safety="safe",
            handler=handler,
        )
    )
