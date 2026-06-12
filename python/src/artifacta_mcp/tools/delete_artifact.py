"""delete_artifact tool — plan §2.9 (destructive)."""
from __future__ import annotations

import re
from typing import Any

from artifacta.errors import ArtifactDeletedError

from ..ids import ARTIFACT_ID_PATTERN
from ..safety import ToolRegistration, register_tool
from ._common import error_result, get_client, passthrough_result

_ARTIFACT_ID_RE = re.compile(ARTIFACT_ID_PATTERN)

DELETE_ARTIFACT_DESCRIPTION = (
    "Soft-delete an artifact. The artifact disappears from listings immediately "
    "and download URLs return `410 Gone`. Storage and the underlying R2 blob are "
    "hard-deleted by a background job 30 days later. There is no undo from the "
    "API — do not call without explicit user confirmation."
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
        body = client.delete(artifact_id)
    except ArtifactDeletedError:
        # Success-on-replay (plan §6.1, AF_MCP-4.1 scope): a second call after
        # the artifact was already soft-deleted should surface as a non-error
        # so the agent doesn't falsely think the delete failed.
        replay = {"artifact_id": artifact_id, "deleted": True, "already_deleted": True}
        return passthrough_result(replay)
    except Exception as exc:
        return error_result(exc, "delete_artifact", {"id": artifact_id})
    # The SDK's delete() also treats already-deleted as success — covers both branches.
    return passthrough_result(body)


def register() -> None:
    register_tool(
        ToolRegistration(
            name="delete_artifact",
            description=DELETE_ARTIFACT_DESCRIPTION,
            input_schema=INPUT_SCHEMA,
            safety="destructive",
            handler=handler,
        )
    )
