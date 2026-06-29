"""unpublish_artifact tool — Task 9 (Artifact Pages publish path)."""
from __future__ import annotations

from typing import Any

from ..safety import ToolRegistration, register_tool
from ._common import error_result, get_client, passthrough_result

UNPUBLISH_ARTIFACT_DESCRIPTION = (
    "Remove the public page for an artifact, making the public URL inaccessible. The artifact "
    "itself is not deleted — only its shareable page is taken down. The URL stops resolving "
    "immediately. Idempotent: calling unpublish on an already-unpublished artifact is a no-op."
)

INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "artifact_id": {"type": "string", "minLength": 1},
    },
    "required": ["artifact_id"],
    "additionalProperties": False,
}

TOOL = {
    "name": "unpublish_artifact",
    "description": UNPUBLISH_ARTIFACT_DESCRIPTION,
    "inputSchema": INPUT_SCHEMA,
}

_INVALID_REQUEST = {
    "isError": True,
    "content": [
        {
            "type": "text",
            "text": "Bad arguments: `artifact_id` is required and must be a non-empty string. Adjust the inputs and call again.",
        }
    ],
    "_meta": {"code": "invalid_request", "status": 400, "retry_hint": "do_not_retry"},
}


async def handler(args: dict[str, Any] | None, _ctx) -> dict[str, Any]:
    a = args or {}

    artifact_id = a.get("artifact_id")
    if not isinstance(artifact_id, str) or len(artifact_id) < 1:
        return _INVALID_REQUEST

    client = get_client()
    try:
        body = client.unpublish(artifact_id)
    except Exception as exc:
        return error_result(exc, "unpublish_artifact")
    return passthrough_result(body)


def register() -> None:
    register_tool(
        ToolRegistration(
            name="unpublish_artifact",
            description=UNPUBLISH_ARTIFACT_DESCRIPTION,
            input_schema=INPUT_SCHEMA,
            safety="writeIdempotent",
            handler=handler,
        )
    )
