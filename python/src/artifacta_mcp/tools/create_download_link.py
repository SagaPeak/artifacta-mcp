"""create_download_link tool — plan §2.8.

Safety: registered as "destructive" (NOT writeNonIdempotent) — per plan §5.2
this is a "warn-and-cache" tool because its side effect is a publicly
accessible URL that crosses the tenant boundary. The destructive gating engine
gives us exactly the consent surface (non-compliant filter + per-call stderr
audit + compliant-client requiresConfirmation).
"""
from __future__ import annotations

import re
from typing import Any

from ..ids import ARTIFACT_ID_PATTERN
from ..safety import ToolRegistration, register_tool
from ._common import error_result, get_client, passthrough_result

_ARTIFACT_ID_RE = re.compile(ARTIFACT_ID_PATTERN)

DEFAULT_EXPIRES_IN = 604800  # 7 days
MAX_EXPIRES_IN = 7776000  # 90 days

CREATE_DOWNLOAD_LINK_DESCRIPTION = (
    "Produce a stable, human-shareable URL (`https://dl.artifacta.io/lnk_<id>`) "
    "that resolves to the artifact bytes for a chosen duration. Use this when an "
    "agent needs to hand off output to a human reviewer or downstream tool that "
    "cannot inject bearer headers. Default expiry is 7 days; max is plan-dependent "
    "(30d Free, 90d Pro). Active links are quota-limited (50 Free, 500 Pro)."
)

INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "artifact_id": {"type": "string", "pattern": ARTIFACT_ID_PATTERN},
        "expires_in": {
            "type": "integer",
            "minimum": 1,
            "maximum": MAX_EXPIRES_IN,
            "default": DEFAULT_EXPIRES_IN,
            "description": "Seconds until the link expires. 7776000 = 90 days.",
        },
    },
    "required": ["artifact_id"],
    "additionalProperties": False,
}


def _local_invalid_request(message: str) -> dict[str, Any]:
    return {
        "isError": True,
        "content": [{"type": "text", "text": f"Bad arguments: {message}. Adjust the inputs and call again."}],
        "_meta": {"code": "invalid_request", "status": 400, "retry_hint": "do_not_retry"},
    }


async def handler(args: dict[str, Any] | None, _ctx) -> dict[str, Any]:
    a = args or {}
    artifact_id = a.get("artifact_id")
    if not isinstance(artifact_id, str) or not _ARTIFACT_ID_RE.match(artifact_id):
        return _local_invalid_request("artifact_id is required and must match ^art_[A-Za-z0-9]{16}$")

    expires_in = DEFAULT_EXPIRES_IN
    if "expires_in" in a and a["expires_in"] is not None:
        ev = a["expires_in"]
        if not isinstance(ev, int) or isinstance(ev, bool) or not (1 <= ev <= MAX_EXPIRES_IN):
            return _local_invalid_request(
                f"expires_in must be an integer from 1 to {MAX_EXPIRES_IN} (90 days)"
            )
        expires_in = ev

    client = get_client()
    try:
        # SDK's create_link signature is create_link(artifact_id, expires_in=…).
        link = client.create_link(artifact_id=artifact_id, expires_in=expires_in)
    except Exception as exc:
        is_ambiguous = getattr(exc, "status", 0) >= 500 or getattr(exc, "code", "") == "network_error"
        return error_result(
            exc,
            "create_download_link",
            {"id": artifact_id},
            ambiguous_completion=is_ambiguous,
        )
    return passthrough_result(link.to_dict())


def register() -> None:
    register_tool(
        ToolRegistration(
            name="create_download_link",
            description=CREATE_DOWNLOAD_LINK_DESCRIPTION,
            input_schema=INPUT_SCHEMA,
            safety="destructive",
            handler=handler,
        )
    )
