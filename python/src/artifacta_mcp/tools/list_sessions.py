"""list_sessions tool — plan §2.10."""
from __future__ import annotations

from typing import Any

from ..safety import ToolRegistration, register_tool
from ._common import error_result, get_client, passthrough_result

LIST_SESSIONS_DESCRIPTION = (
    "List session IDs synthesized from the calling tenant's artifacts, ordered "
    "by most recent activity. Each entry includes artifact count, seal status, "
    "and first/last activity timestamps. Sessions are not first-class — they "
    "exist only as long as artifacts reference them."
)

LIST_LIMIT_DEFAULT = 50

INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "created_after": {"type": "string", "format": "date-time"},
        "created_before": {"type": "string", "format": "date-time"},
        "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 200,
            "default": LIST_LIMIT_DEFAULT,
        },
        "cursor": {"type": "string"},
    },
    "required": [],
    "additionalProperties": False,
}


def build_params(args: dict[str, Any] | None) -> dict[str, Any]:
    a = args or {}
    params: dict[str, Any] = {}
    if isinstance(a.get("created_after"), str):
        params["created_after"] = a["created_after"]
    if isinstance(a.get("created_before"), str):
        params["created_before"] = a["created_before"]
    limit = a.get("limit")
    params["limit"] = int(limit) if isinstance(limit, int) else LIST_LIMIT_DEFAULT
    # API uses `after` for the session cursor; MCP boundary keeps `cursor` for agent consistency.
    cursor = a.get("cursor")
    if isinstance(cursor, str):
        params["after"] = cursor
    return params


async def handler(args: dict[str, Any] | None, _ctx) -> dict[str, Any]:
    client = get_client()
    params = build_params(args)
    try:
        resp = client._request("GET", "/v1/sessions", params=params)
        body = resp.json()
    except Exception as exc:
        return error_result(exc, "list_sessions")
    return passthrough_result(body)


def register() -> None:
    register_tool(
        ToolRegistration(
            name="list_sessions",
            description=LIST_SESSIONS_DESCRIPTION,
            input_schema=INPUT_SCHEMA,
            safety="safe",
            handler=handler,
        )
    )
