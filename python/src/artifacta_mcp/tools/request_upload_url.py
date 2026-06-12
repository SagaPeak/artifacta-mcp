"""request_upload_url tool — plan §2.6."""
from __future__ import annotations

import re
from typing import Any

from ..ids import SESSION_ID_PATTERN
from ..safety import ToolRegistration, register_tool
from ._common import error_result, get_client, passthrough_result

REQUEST_UPLOAD_URL_DESCRIPTION = (
    "Reserve a presigned R2 PUT URL for a file too large to send through "
    "`store_artifact` (over 500 MB up to 5 GB). Returns an `upload_url`, headers "
    "to include in the PUT, and an `artifact_id` in `pending` state. The agent (or "
    "its environment) PUTs the bytes directly to R2, then calls `complete_upload`. "
    "Pro plan only. Most agents should use `store_artifact` and let the MCP server "
    "pick the path automatically.\n\n"
    "Not retry-safe: this endpoint does not support idempotency keys, so on an HTTP "
    "5xx or network error the reservation may or may not have been created. Do NOT "
    "blindly retry — the error guidance tells you to first call `list_artifacts` "
    "with the same `session_id`/`agent_id` to detect any pending artifact, so you "
    "don't create a duplicate."
)

MAX_SIZE_BYTES = 5 * 1024 * 1024 * 1024  # 5 GB — §2.6 ceiling
METADATA_KEY_PATTERN = r"^[a-zA-Z][a-zA-Z0-9_-]{0,63}$"
_METADATA_KEY_RE = re.compile(METADATA_KEY_PATTERN)
_SESSION_ID_RE = re.compile(SESSION_ID_PATTERN)

INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "filename": {"type": "string", "minLength": 1, "maxLength": 255},
        "content_type": {"type": "string"},
        "size_bytes": {"type": "integer", "minimum": 1, "maximum": MAX_SIZE_BYTES},
        "session_id": {"type": "string", "pattern": SESSION_ID_PATTERN},
        "agent_id": {"type": "string"},
        "metadata": {
            "type": "object",
            "patternProperties": {METADATA_KEY_PATTERN: {"type": "string", "maxLength": 1024}},
            "additionalProperties": False,
        },
        "ttl": {"type": "string"},
    },
    "required": ["filename", "content_type", "size_bytes"],
    "additionalProperties": False,
}


def _local_invalid_request(message: str) -> dict[str, Any]:
    return {
        "isError": True,
        "content": [{"type": "text", "text": f"Bad arguments: {message}. Adjust the inputs and call again."}],
        "_meta": {"code": "invalid_request", "status": 400, "retry_hint": "do_not_retry"},
    }


def _validate_metadata(value: Any) -> str | None:
    if not isinstance(value, dict):
        return "`metadata` must be an object of string values"
    for k, v in value.items():
        if not isinstance(k, str) or not _METADATA_KEY_RE.match(k):
            return f"metadata key '{k}' is invalid; keys must match {METADATA_KEY_PATTERN}"
        if not isinstance(v, str):
            return f"metadata value for '{k}' must be a string"
        if len(v) > 1024:
            return f"metadata value for '{k}' exceeds the 1024-character limit"
    return None


async def handler(args: dict[str, Any] | None, _ctx) -> dict[str, Any]:
    a = args or {}

    filename = a.get("filename")
    if not isinstance(filename, str) or not (1 <= len(filename) <= 255):
        return _local_invalid_request("`filename` is required and must be a string of 1-255 characters")
    content_type = a.get("content_type")
    if not isinstance(content_type, str) or len(content_type) < 1:
        return _local_invalid_request("`content_type` is required and must be a non-empty string")
    size_bytes = a.get("size_bytes")
    if not isinstance(size_bytes, int) or isinstance(size_bytes, bool) or not (1 <= size_bytes <= MAX_SIZE_BYTES):
        return _local_invalid_request(
            f"`size_bytes` is required and must be an integer from 1 to {MAX_SIZE_BYTES} (5 GB)"
        )

    for key in ("session_id", "agent_id", "ttl"):
        if a.get(key) is not None and not isinstance(a.get(key), str):
            return _local_invalid_request(f"`{key}` must be a string")

    session_id = a.get("session_id")
    if isinstance(session_id, str) and not _SESSION_ID_RE.match(session_id):
        return _local_invalid_request(
            f"`session_id` must match {SESSION_ID_PATTERN} "
            "(alphanumeric start; alnum, dot, underscore, hyphen body; 1–128 chars)"
        )

    if "metadata" in a:
        meta_err = _validate_metadata(a["metadata"])
        if meta_err:
            return _local_invalid_request(meta_err)

    metadata = a.get("metadata") if isinstance(a.get("metadata"), dict) else None
    ttl = a.get("ttl") if isinstance(a.get("ttl"), str) else None
    agent_id = a.get("agent_id") if isinstance(a.get("agent_id"), str) else None

    client = get_client()
    try:
        body = client.request_upload_url(
            filename=filename,
            content_type=content_type,
            size_bytes=size_bytes,
            session_id=session_id if isinstance(session_id, str) else None,
            agent_id=agent_id,
            metadata=metadata,
            ttl=ttl,
        )
    except Exception as exc:
        # nonIdempotentWrite: any 5xx is ambiguous — surface §6.1 guidance.
        is_ambiguous = isinstance(exc, Exception) and (
            getattr(exc, "status", 0) >= 500 or getattr(exc, "code", "") == "network_error"
        )
        return error_result(exc, "request_upload_url", ambiguous_completion=is_ambiguous)
    return passthrough_result(body)


def register() -> None:
    register_tool(
        ToolRegistration(
            name="request_upload_url",
            description=REQUEST_UPLOAD_URL_DESCRIPTION,
            input_schema=INPUT_SCHEMA,
            safety="writeNonIdempotent",
            handler=handler,
        )
    )
