"""get_artifact_download_url tool — plan §2.4."""
from __future__ import annotations

from typing import Any

from ..ids import ARTIFACT_ID_PATTERN
from ..safety import ToolRegistration, register_tool
from ._common import error_result, get_client, passthrough_result

GET_ARTIFACT_DOWNLOAD_URL_DESCRIPTION = (
    "Generate a short-lived presigned URL (1 hour) the agent can use to download "
    "the artifact's bytes directly from Cloudflare R2. Use this when the agent "
    "itself needs to consume the file. For sharing with humans, use "
    "`create_download_link` instead — that produces a stable `dl.artifacta.io/lnk_…` "
    "URL with configurable expiry."
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
        resp = client._request("GET", f"/v1/artifacts/{artifact_id}/download-url")
        body = resp.json()
    except Exception as exc:
        return error_result(exc, "get_artifact_download_url", {"id": artifact_id})
    return passthrough_result(body)


def register() -> None:
    register_tool(
        ToolRegistration(
            name="get_artifact_download_url",
            description=GET_ARTIFACT_DOWNLOAD_URL_DESCRIPTION,
            input_schema=INPUT_SCHEMA,
            safety="safe",
            handler=handler,
        )
    )
