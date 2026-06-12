"""store_artifact tool — plan §2.5.

Supports inline `content` (base64, ~10 MB ceiling) OR local `path` (multipart,
500 MB ceiling, path-confinement gated). Auto-injects an Idempotency-Key when
none is supplied so crash-safe retries within a single MCP call don't double-write.

Mirrors `mcp/typescript/src/tools/store-artifact*.ts` with one intentional
simplification: the Python SDK's `Client.push()` already does multipart upload
under the hood (httpx multipart), so we don't replicate the streaming-multipart
implementation here. Path uploads still go through `check_path` for confinement
before any byte is read.
"""
from __future__ import annotations

import base64
import os
import re
import uuid
from typing import Any

from .. import allowlist, path_confinement
from ..ids import SESSION_ID_PATTERN
from ..path_confinement import ConfinementAllow
from ..safety import ToolRegistration, register_tool
from ._common import error_result, get_client, passthrough_result

STORE_ARTIFACT_DESCRIPTION = (
    "Upload a file as a new artifact in a single call. Provide EITHER up to ~10 MB of "
    "base64-encoded bytes via `content`, OR a local filesystem `path` that the MCP server "
    "reads and streams as multipart/form-data (up to 500 MB). For files larger than 500 MB, "
    "use `request_upload_url` (Pro only) instead — `store_artifact` returns `file_too_large` "
    "for them. Tags the artifact with `session_id` / `agent_id` / `metadata` for later "
    "retrieval and returns the full artifact record including its new `artifact_id` and "
    "`content_hash`.\n\n"
    "Path uploads are confined. The `path` argument is constrained to the launcher-configured "
    "allow-list (default: the MCP server's CWD). Paths outside the allow-list, paths traversing "
    "symlinks out of it, and paths to known-sensitive locations (`~/.ssh`, `~/.aws`, `/etc/`, "
    "etc.) are refused with `invalid_request`.\n\n"
    "For crash-safe retries, supply your own `idempotency_key` (any string ≤256 chars): a replay "
    "within 24h returns the original artifact and never double-bills. If you omit it, the server "
    "auto-generates one and returns it under `_meta.idempotency_key`, but that key protects only "
    "in-process retries within a single call — it is lost if the server restarts, so pre-commit "
    "your own key when durability matters."
)

METADATA_KEY_PATTERN = r"^[a-zA-Z][a-zA-Z0-9_-]{0,63}$"
_METADATA_KEY_RE = re.compile(METADATA_KEY_PATTERN)
_SESSION_ID_RE = re.compile(SESSION_ID_PATTERN)

CONTENT_MAX_BYTES = 10 * 1024 * 1024  # ~10 MB after base64 decode

INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "filename": {"type": "string", "minLength": 1, "maxLength": 255},
        "content": {
            "type": "string",
            "contentEncoding": "base64",
            "description": (
                "Base64-encoded bytes. Use for content under 10 MB or when no local path is available."
            ),
        },
        "path": {
            "type": "string",
            "description": (
                "Absolute local path inside the launcher-configured allow-list. The MCP server "
                "reads and streams this as multipart. Mutually exclusive with `content`. "
                "See §4.4 for confinement rules."
            ),
        },
        "content_type": {
            "type": "string",
            "description": "MIME type. If omitted, guessed from filename.",
        },
        "session_id": {"type": "string", "pattern": SESSION_ID_PATTERN},
        "agent_id": {"type": "string"},
        "metadata": {
            "type": "object",
            "patternProperties": {METADATA_KEY_PATTERN: {"type": "string", "maxLength": 1024}},
            "additionalProperties": False,
        },
        "ttl": {
            "type": "string",
            "description": "Duration suffix (e.g. `7d`, `30d`) or `never` (Pro only). Defaults to plan default.",
        },
        "idempotency_key": {"type": "string", "minLength": 1, "maxLength": 256},
    },
    "required": ["filename"],
    "oneOf": [{"required": ["content"]}, {"required": ["path"]}],
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


def _generate_idempotency_key() -> str:
    return f"mcp_{uuid.uuid4().hex}"


async def handler(args: dict[str, Any] | None, _ctx) -> dict[str, Any]:
    a = args or {}

    filename = a.get("filename")
    if not isinstance(filename, str) or not (1 <= len(filename) <= 255):
        return _local_invalid_request("`filename` is required and must be a string of 1-255 characters")

    has_content = "content" in a
    has_path = "path" in a
    if has_content and has_path:
        return _local_invalid_request("provide exactly one of `content` or `path`, not both")
    if not has_content and not has_path:
        return _local_invalid_request("provide exactly one of `content` or `path`")

    if has_content and not isinstance(a["content"], str):
        return _local_invalid_request("`content` must be a base64-encoded string")
    if has_path and not isinstance(a["path"], str):
        return _local_invalid_request("`path` must be a string")

    for key in ("content_type", "session_id", "agent_id", "ttl"):
        if a.get(key) is not None and not isinstance(a.get(key), str):
            return _local_invalid_request(f"`{key}` must be a string")

    session_id = a.get("session_id")
    if isinstance(session_id, str) and not _SESSION_ID_RE.match(session_id):
        return _local_invalid_request(
            f"`session_id` must match {SESSION_ID_PATTERN} "
            "(alphanumeric start; alnum, dot, underscore, hyphen body; 1–128 chars)"
        )

    idem = a.get("idempotency_key")
    if idem is not None:
        if not isinstance(idem, str) or not (1 <= len(idem) <= 256):
            return _local_invalid_request("`idempotency_key` must be a string of 1-256 characters")

    if "metadata" in a:
        meta_err = _validate_metadata(a["metadata"])
        if meta_err:
            return _local_invalid_request(meta_err)

    metadata = a.get("metadata") if isinstance(a.get("metadata"), dict) else None
    content_type = a.get("content_type") if isinstance(a.get("content_type"), str) else None
    ttl = a.get("ttl") if isinstance(a.get("ttl"), str) else None
    agent_id = a.get("agent_id") if isinstance(a.get("agent_id"), str) else None
    idempotency_key = idem if isinstance(idem, str) else _generate_idempotency_key()
    auto_injected = idem is None

    client = get_client()

    if has_content:
        try:
            file_bytes = base64.b64decode(a["content"], validate=True)
        except (ValueError, TypeError):
            return _local_invalid_request("`content` is not valid base64")
        if len(file_bytes) > CONTENT_MAX_BYTES:
            return _local_invalid_request(
                f"`content` exceeds the {CONTENT_MAX_BYTES} byte (~10 MB) inline limit; use `path` or `request_upload_url`"
            )
        try:
            artifact = client.push(
                content=file_bytes,
                filename=filename,
                content_type=content_type,
                session_id=session_id if isinstance(session_id, str) else None,
                agent_id=agent_id,
                metadata=metadata,
                ttl=ttl,
                idempotency_key=idempotency_key,
            )
        except Exception as exc:
            return error_result(exc, "store_artifact")
        result = passthrough_result(artifact.to_dict())
    else:
        # Path branch — confinement gate, then upload the bytes from the
        # validated fd. The fd captured by check_path is our TOCTOU shield:
        # reading through it (instead of re-opening the resolved path) defends
        # against any swap that changes the dirent's inode (unlink + create,
        # symlink redirection).
        #
        # An in-place mutation (e.g. open(path, "wb") which O_TRUNCs the same
        # inode our fd holds) DOES leak through the fd alone — the rewritten
        # bytes appear at offset 0. We close that hole the same way the TS
        # engine does: after reading exactly result_check.size bytes, re-fstat
        # the still-open fd and compare size + mtime against the values
        # captured during the initial check. Any drift → refuse the upload.
        # The mtime check is the decisive signal; O_TRUNC bumps mtime
        # unconditionally on POSIX.
        allow_roots = allowlist.get_allow_roots()
        result_check = path_confinement.check_path(a["path"], allow_roots)
        if not isinstance(result_check, ConfinementAllow):
            return _local_invalid_request(result_check.reason.split(": ", 1)[-1])

        fd = result_check.fd
        try:
            try:
                # Read up to the validated size. We use os.read in chunks so
                # we never buffer more than result_check.size bytes — caps
                # the impact of a same-size, mtime-preserving in-place edit
                # (an irreducible residual race).
                chunks: list[bytes] = []
                remaining = result_check.size
                while remaining > 0:
                    chunk = os.read(fd, min(64 * 1024, remaining))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    remaining -= len(chunk)
                file_bytes = b"".join(chunks)

                # Tripwire: re-fstat the still-open fd. If size or mtime
                # changed since check_path's fstat, the file was mutated
                # in place during the validation → upload window. Refuse.
                post_stat = os.fstat(fd)
                post_mtime_ms = post_stat.st_mtime * 1000.0
                if (
                    post_stat.st_size != result_check.size
                    or post_mtime_ms != result_check.mtime_ms
                ):
                    return _local_invalid_request(
                        f"Path '{result_check.resolved_path}' was modified during the "
                        "confinement→upload window; refusing upload"
                    )
            except OSError as exc:
                return _local_invalid_request(
                    f"Path '{result_check.resolved_path}' could not be read: {exc.strerror or exc!s}"
                )
        finally:
            try:
                os.close(fd)
            except OSError:
                pass

        try:
            artifact = client.push(
                content=file_bytes,
                filename=filename,
                content_type=content_type,
                session_id=session_id if isinstance(session_id, str) else None,
                agent_id=agent_id,
                metadata=metadata,
                ttl=ttl,
                idempotency_key=idempotency_key,
            )
        except Exception as exc:
            return error_result(exc, "store_artifact")
        result = passthrough_result(artifact.to_dict())

    if auto_injected:
        result.setdefault("_meta", {})["idempotency_key"] = idempotency_key
    return result


def register() -> None:
    register_tool(
        ToolRegistration(
            name="store_artifact",
            description=STORE_ARTIFACT_DESCRIPTION,
            input_schema=INPUT_SCHEMA,
            safety="writeIdempotent",
            handler=handler,
        )
    )
