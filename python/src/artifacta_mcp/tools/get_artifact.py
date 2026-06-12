"""get_artifact tool — plan §2.3."""
from __future__ import annotations

from typing import Any

from ..ids import ARTIFACT_ID_PATTERN
from ..safety import ToolRegistration, register_tool
from ._common import error_result, get_client, passthrough_result

GET_ARTIFACT_DESCRIPTION = (
    "Fetch metadata for a single artifact by ID: filename, content type, size, "
    "content hash, session/agent IDs, custom metadata, expiry, creation timestamp. "
    "Does NOT return the file bytes — call `get_artifact_download_url` for that. "
    "Returns `artifact_not_found` for unknown IDs, `artifact_already_deleted` "
    "(HTTP 410) for soft-deleted ones, `artifact_expired` (410) for those past "
    "their TTL."
)

INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "artifact_id": {"type": "string", "pattern": ARTIFACT_ID_PATTERN},
    },
    "required": ["artifact_id"],
    "additionalProperties": False,
}


async def handler(args: dict[str, Any] | None, _ctx) -> dict[str, Any]:
    artifact_id = (args or {}).get("artifact_id")
    if not isinstance(artifact_id, str):
        return {
            "isError": True,
            "content": [
                {
                    "type": "text",
                    "text": "Bad arguments: artifact_id is required and must match ^art_[A-Za-z0-9]{16}$.",
                }
            ],
            "_meta": {"code": "invalid_request", "status": 400, "retry_hint": "do_not_retry"},
        }
    client = get_client()
    try:
        artifact = client.get(artifact_id)
    except Exception as exc:
        return error_result(exc, "get_artifact", {"id": artifact_id})
    return passthrough_result(artifact.to_dict())


def register() -> None:
    register_tool(
        ToolRegistration(
            name="get_artifact",
            description=GET_ARTIFACT_DESCRIPTION,
            input_schema=INPUT_SCHEMA,
            safety="safe",
            handler=handler,
        )
    )
