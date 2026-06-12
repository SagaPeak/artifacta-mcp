"""Error translation — Python port of mcp/typescript/src/errors/{messages,translate}.ts.

Every Artifacta API error code maps to an agent-readable summary line copied
VERBATIM from plan §6. The strings are the contract — never rename or
paraphrase. The `translate_http_failure` helper turns an `HttpFailure` into
the MCP `CallToolResult` shape with `isError: true`, the §6 text, and a
`_meta` block containing `{status, code, retry_hint, ...}`.

Auth failures use a structured remediation template that includes the last
4 chars of the cached API key when available (`whoami_cache.set_key_suffix`).

Ambiguous-completion (mid-write 5xx on non-idempotent writes) routes to
`AMBIGUOUS_COMPLETION_GUIDANCE` with do-not-retry hint — agent must check
listings before retry to avoid duplicate writes.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal

from . import whoami_cache

# ---------------------------------------------------------------------------
# Agent-readable summaries — VERBATIM from plan §6 (do not paraphrase)
# ---------------------------------------------------------------------------

AGENT_SUMMARIES: dict[str, str] = {
    "invalid_request": "Bad arguments: {{message}}. Adjust the inputs and call again.",
    "unauthorized": "Authentication failed. See setup instructions in the tool's response.",
    "quota_exceeded": "Plan quota exceeded: {{message}}. Upgrade at {{upgrade_url}} or wait for monthly reset.",
    "ttl_exceeds_plan_limit": "Requested TTL exceeds plan max. Reduce TTL or upgrade at {{upgrade_url}}.",
    "artifact_not_found": "Artifact {{id}} does not exist or is not visible to this tenant.",
    "session_not_found": "No artifacts exist for session {{id}}. Sessions are synthesized from artifacts — create one first.",
    "session_sealed": "Session {{id}} is sealed. Use a different session_id or unseal externally.",
    "artifact_expired": "Artifact {{id}} expired at {{expires_at}}. Re-upload if still needed.",
    "artifact_already_deleted": "Artifact {{id}} was deleted at {{deleted_at}}.",
    "file_too_large": "File exceeds path limit. Use `request_upload_url` for files > 500 MB (Pro only).",
    "upload_not_found": "Bytes for artifact {{id}} have not arrived at R2 yet. PUT to the presigned URL and retry.",
    "rate_limited": "Rate limit hit ({{limit}}/min). Server requested retry in {{retry_after_seconds}}s — the MCP server will auto-retry once with backoff.",
}

AMBIGUOUS_COMPLETION_GUIDANCE = """Artifacta API failed mid-write on {{tool}}. The backend may or may not have created the record.
Before retrying:
- For request_upload_url: call list_artifacts with the same session_id/agent_id and a recent created_after to detect any pending artifact that was created.
- For create_download_link: there is no list-links API in v1; if the agent cannot tolerate a possible extra link, surface to the human user.
Retrying without checking risks creating a duplicate."""

SERVER_5XX_SUMMARY = (
    "Artifacta API returned {{status}}. Retried {{n}} times. If the issue persists, status at status.artifacta.io."
)

TENANT_SUSPENDED_SUMMARY = (
    "Account is scheduled for deletion — see https://app.artifacta.io/dashboard/account."
)

AUTH_REMEDIATION_TEMPLATE = (
    "Artifacta authentication failed: {{message}}. Set ARTIFACTA_API_KEY to a valid key from "
    "https://app.artifacta.io/dashboard/keys, or pass --api-key when launching the MCP server."
    "{{keySuffix}}"
)


RetryHint = Literal["do_not_retry", "retry_after", "retry_with_backoff"]


_RETRY_HINTS: dict[str, RetryHint] = {
    "invalid_request": "do_not_retry",
    "unauthorized": "do_not_retry",
    "quota_exceeded": "do_not_retry",
    "ttl_exceeds_plan_limit": "do_not_retry",
    "artifact_not_found": "do_not_retry",
    "session_not_found": "do_not_retry",
    "session_sealed": "do_not_retry",
    "artifact_expired": "do_not_retry",
    "artifact_already_deleted": "do_not_retry",
    "file_too_large": "do_not_retry",
    "upload_not_found": "do_not_retry",
    "rate_limited": "retry_after",
    "network_error": "retry_with_backoff",
    "server_error": "retry_with_backoff",
}


# ---------------------------------------------------------------------------
# Failure descriptor (transport-agnostic — built from SDK exceptions or raw HTTP)
# ---------------------------------------------------------------------------


@dataclass
class HttpErrorBody:
    code: str
    message: str
    status: int = 0
    upgrade_url: str | None = None
    retry_after: float | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class HttpFailure:
    error: HttpErrorBody
    attempts: int = 1
    ambiguous_completion: bool = False


# ---------------------------------------------------------------------------
# Template substitution
# ---------------------------------------------------------------------------


_TEMPLATE_VAR_PATTERN = re.compile(r"\{\{(\w+)\}\}")


def _fill(template: str, vars_: dict[str, str | None]) -> str:
    def repl(match: re.Match[str]) -> str:
        key = match.group(1)
        v = vars_.get(key)
        return "" if v is None else str(v)

    return _TEMPLATE_VAR_PATTERN.sub(repl, template)


def _build_auth_text(message: str) -> str:
    key_suffix = whoami_cache.get_cached_key_suffix()
    suffix_fragment = f" Last-known key suffix: ****{key_suffix}." if key_suffix else ""
    return _fill(AUTH_REMEDIATION_TEMPLATE, {"message": message, "keySuffix": suffix_fragment})


def _build_summary_text(
    code: str,
    error: HttpErrorBody,
    extra_vars: dict[str, str | None] | None = None,
) -> str:
    template = AGENT_SUMMARIES.get(code)
    if template is None:
        return f"Artifacta error ({code}): {error.message}"
    variables: dict[str, str | None] = {
        "message": error.message,
        "upgrade_url": error.upgrade_url,
        **(extra_vars or {}),
    }
    return _fill(template, variables)


# ---------------------------------------------------------------------------
# Translator — main entry point
# ---------------------------------------------------------------------------


def translate_http_failure(
    failure: HttpFailure,
    tool_name: str | None = None,
    extra_vars: dict[str, str | None] | None = None,
) -> dict[str, Any]:
    """Turn an HttpFailure into an MCP error CallToolResult dict.

    Returns `{isError: true, content: [...], _meta: {...}}` ready to hand
    back to the MCP SDK.
    """
    err = failure.error
    code = err.code
    status = err.status
    upgrade_url = err.upgrade_url
    retry_after_secs = err.retry_after

    # 1. Ambiguous-completion (mid-write 5xx on non-idempotent writes)
    if failure.ambiguous_completion and tool_name:
        text = _fill(AMBIGUOUS_COMPLETION_GUIDANCE, {"tool": tool_name})
        return {
            "isError": True,
            "content": [{"type": "text", "text": text}],
            "_meta": {
                "status": status or 0,
                "code": code or "server_error",
                "retry_hint": "do_not_retry",
            },
        }

    # 2. Tenant suspended (account in deletion grace period)
    if code == "unauthorized" and (err.message or "").lower().find("suspended") != -1:
        return {
            "isError": True,
            "content": [{"type": "text", "text": TENANT_SUSPENDED_SUMMARY}],
            "_meta": {
                "status": status,
                "code": code,
                "retry_hint": "do_not_retry",
                **({"upgrade_url": upgrade_url} if upgrade_url else {}),
            },
        }

    # 3. Auth failure with structured remediation
    if code == "unauthorized":
        return {
            "isError": True,
            "content": [{"type": "text", "text": _build_auth_text(err.message)}],
            "_meta": {"status": status, "code": code, "retry_hint": "do_not_retry"},
        }

    # 4. 5xx / network (non-ambiguous) — includes retry count
    if code in ("server_error", "network_error") or (500 <= status < 600):
        text = _fill(SERVER_5XX_SUMMARY, {"status": str(status), "n": str(failure.attempts)})
        return {
            "isError": True,
            "content": [{"type": "text", "text": text}],
            "_meta": {
                "status": status or 0,
                "code": code or "server_error",
                "retry_hint": "retry_with_backoff",
            },
        }

    # 5. rate_limited with retry_after
    if code == "rate_limited":
        text = _build_summary_text(
            code,
            err,
            {
                "retry_after_seconds": str(retry_after_secs) if retry_after_secs is not None else "unknown",
                "limit": "unknown",
            },
        )
        meta: dict[str, Any] = {"status": status, "code": code, "retry_hint": "retry_after"}
        if retry_after_secs is not None:
            meta["retry_after_seconds"] = retry_after_secs
        return {"isError": True, "content": [{"type": "text", "text": text}], "_meta": meta}

    # 6. All other codes from the CLAUDE.md taxonomy
    text = _build_summary_text(code, err, extra_vars)
    retry_hint: RetryHint = _RETRY_HINTS.get(code, "do_not_retry")
    meta_out: dict[str, Any] = {"status": status, "code": code, "retry_hint": retry_hint}
    if upgrade_url:
        meta_out["upgrade_url"] = upgrade_url
    return {"isError": True, "content": [{"type": "text", "text": text}], "_meta": meta_out}


# ---------------------------------------------------------------------------
# SDK exception → HttpFailure adapter
# ---------------------------------------------------------------------------


def failure_from_sdk_error(exc: Exception) -> HttpFailure:
    """Translate an `artifacta.errors.ArtifactaError` (or subclass) into HttpFailure.

    The SDK raises typed exceptions (`AuthenticationError`, `QuotaExceededError`,
    etc.); each carries `.code`, `.message`, `.status`, optional `.upgrade_url`
    and `.retry_after`. We marshal those into the transport-agnostic HttpFailure
    so the translator stays decoupled from the SDK.
    """
    code = getattr(exc, "code", None) or _infer_code_from_type(exc)
    message = getattr(exc, "message", None) or str(exc)
    status = int(getattr(exc, "status", 0) or 0)
    upgrade_url = getattr(exc, "upgrade_url", None)
    retry_after = getattr(exc, "retry_after", None)

    body = HttpErrorBody(
        code=code,
        message=message,
        status=status,
        upgrade_url=upgrade_url,
        retry_after=retry_after,
    )
    return HttpFailure(error=body)


def _infer_code_from_type(exc: Exception) -> str:
    name = type(exc).__name__
    mapping = {
        "AuthenticationError": "unauthorized",
        "InvalidRequestError": "invalid_request",
        "ArtifactNotFoundError": "artifact_not_found",
        "ArtifactExpiredError": "artifact_expired",
        "ArtifactDeletedError": "artifact_already_deleted",
        "SessionSealedError": "session_sealed",
        "SessionNotFoundError": "session_not_found",
        "QuotaExceededError": "quota_exceeded",
        "TTLExceedsPlanLimitError": "ttl_exceeds_plan_limit",
        "RateLimitedError": "rate_limited",
        "FileTooLargeError": "file_too_large",
        "UploadNotFoundError": "upload_not_found",
    }
    return mapping.get(name, "server_error")
