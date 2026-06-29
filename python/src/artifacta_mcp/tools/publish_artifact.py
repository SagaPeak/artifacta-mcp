"""publish_artifact tool — Task 9 (Artifact Pages publish path)."""
from __future__ import annotations

from typing import Any

from ..safety import ToolRegistration, register_tool
from ._common import error_result, get_client, passthrough_result

PUBLISH_ARTIFACT_DESCRIPTION = (
    "Publish an existing artifact as a polished, shareable public page at "
    "https://artifacta.io/a/{slug}. Composes with store_artifact (store first, then publish). "
    "Returns a public_url anyone can open without an Artifacta account. Default visibility is "
    'unlisted (link-only); pass visibility:"public" for gallery-eligible later. Idempotent: '
    "re-publishing the same artifact_id updates the existing page and keeps the same URL."
)

INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "artifact_id": {"type": "string", "minLength": 1},
        "title": {"type": "string", "maxLength": 255},
        "visibility": {"type": "string", "enum": ["unlisted", "public"]},
        "access": {"type": "string", "enum": ["none", "password"]},
    },
    "required": ["artifact_id"],
    "additionalProperties": False,
}

TOOL = {
    "name": "publish_artifact",
    "description": PUBLISH_ARTIFACT_DESCRIPTION,
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

    title = a.get("title")
    visibility = a.get("visibility", "unlisted")
    access = a.get("access", "none")

    client = get_client()
    try:
        body = client.publish_artifact(
            artifact_id,
            title=title if isinstance(title, str) else None,
            visibility=visibility if isinstance(visibility, str) else "unlisted",
            access=access if isinstance(access, str) else "none",
        )
    except Exception as exc:
        return error_result(exc, "publish_artifact")
    return passthrough_result(body)


def register() -> None:
    register_tool(
        ToolRegistration(
            name="publish_artifact",
            description=PUBLISH_ARTIFACT_DESCRIPTION,
            input_schema=INPUT_SCHEMA,
            safety="writeIdempotent",
            handler=handler,
        )
    )
