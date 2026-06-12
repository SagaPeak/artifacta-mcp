"""seal_session tool — plan §2.11 (destructive)."""
from __future__ import annotations

import re
from typing import Any

from ..ids import SESSION_ID_PATTERN
from ..safety import ToolRegistration, register_tool
from ._common import error_result, get_client, passthrough_result

_SESSION_ID_RE = re.compile(SESSION_ID_PATTERN)

SEAL_SESSION_DESCRIPTION = (
    "Permanently prevent further artifacts from being added to a session. "
    "Existing artifacts remain readable and downloadable. Sealing a session is "
    "**irreversible** — there is no `unseal` endpoint. Use this only when an "
    "agent's pipeline has confirmed completion and you want to harden the "
    "session against late-write corruption."
)

INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "session_id": {
            "type": "string",
            "minLength": 1,
            "pattern": SESSION_ID_PATTERN,
        },
    },
    "required": ["session_id"],
    "additionalProperties": False,
}


async def handler(args: dict[str, Any] | None, _ctx) -> dict[str, Any]:
    session_id = (args or {}).get("session_id")
    if not isinstance(session_id, str) or not _SESSION_ID_RE.match(session_id):
        return {
            "isError": True,
            "content": [
                {
                    "type": "text",
                    "text": "Bad arguments: session_id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ (alphanumeric start; alnum, dot, underscore, hyphen body; 1–128 chars). Adjust the inputs and call again.",
                }
            ],
            "_meta": {"code": "invalid_request", "status": 400, "retry_hint": "do_not_retry"},
        }

    client = get_client()
    try:
        info = client.seal_session(session_id)
    except Exception as exc:
        return error_result(exc, "seal_session", {"id": session_id})
    return passthrough_result(info.to_dict())


def register() -> None:
    register_tool(
        ToolRegistration(
            name="seal_session",
            description=SEAL_SESSION_DESCRIPTION,
            input_schema=INPUT_SCHEMA,
            safety="destructive",
            handler=handler,
        )
    )
