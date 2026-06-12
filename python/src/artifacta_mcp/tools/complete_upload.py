"""complete_upload tool — plan §2.7."""
from __future__ import annotations

import re
from typing import Any

from ..ids import ARTIFACT_ID_PATTERN
from ..safety import ToolRegistration, register_tool
from ._common import error_result, get_client, passthrough_result

_ARTIFACT_ID_RE = re.compile(ARTIFACT_ID_PATTERN)

COMPLETE_UPLOAD_DESCRIPTION = (
    "Finalize an artifact previously reserved via `request_upload_url` after the "
    "bytes have been PUT to the presigned URL. Server verifies the blob, computes "
    "the content hash, transitions the artifact from `pending` to `active`, and "
    "increments tenant usage. Calling this on an already-active artifact is "
    "idempotent and returns the existing record. Calling before the PUT completes "
    "returns `upload_not_found` — wait and retry."
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
    if not isinstance(artifact_id, str) or not _ARTIFACT_ID_RE.match(artifact_id):
        return {
            "isError": True,
            "content": [
                {
                    "type": "text",
                    "text": "Bad arguments: artifact_id is required and must match ^art_[A-Za-z0-9]{16}$. Adjust the inputs and call again.",
                }
            ],
            "_meta": {"code": "invalid_request", "status": 400, "retry_hint": "do_not_retry"},
        }

    client = get_client()
    try:
        body = client.complete_upload(artifact_id)
    except Exception as exc:
        return error_result(exc, "complete_upload", {"id": artifact_id})
    return passthrough_result(body)


def register() -> None:
    register_tool(
        ToolRegistration(
            name="complete_upload",
            description=COMPLETE_UPLOAD_DESCRIPTION,
            input_schema=INPUT_SCHEMA,
            safety="writeIdempotent",
            handler=handler,
        )
    )
