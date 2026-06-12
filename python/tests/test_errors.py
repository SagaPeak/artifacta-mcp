"""Unit tests for the error-translation engine."""
from __future__ import annotations

import pytest

from artifacta_mcp import whoami_cache
from artifacta_mcp.errors import (
    AGENT_SUMMARIES,
    TENANT_SUSPENDED_SUMMARY,
    HttpErrorBody,
    HttpFailure,
    failure_from_sdk_error,
    translate_http_failure,
)


@pytest.fixture(autouse=True)
def _clear_cache():
    whoami_cache.clear_key_suffix_cache()
    yield
    whoami_cache.clear_key_suffix_cache()


# ---------------------------------------------------------------------------
# Taxonomy invariants
# ---------------------------------------------------------------------------


def test_all_12_codes_have_summary_lines():
    expected = {
        "invalid_request",
        "unauthorized",
        "quota_exceeded",
        "ttl_exceeds_plan_limit",
        "artifact_not_found",
        "session_not_found",
        "session_sealed",
        "artifact_expired",
        "artifact_already_deleted",
        "file_too_large",
        "upload_not_found",
        "rate_limited",
    }
    assert expected == set(AGENT_SUMMARIES.keys())


# ---------------------------------------------------------------------------
# Round-trip every code
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "code,status,extra_vars,expected_in_text",
    [
        ("invalid_request", 400, None, "Bad arguments"),
        ("quota_exceeded", 402, None, "Plan quota exceeded"),
        ("ttl_exceeds_plan_limit", 402, None, "Requested TTL exceeds plan max"),
        ("artifact_not_found", 404, {"id": "art_abc1234567890123"}, "art_abc1234567890123"),
        ("session_not_found", 404, {"id": "sess_xyz"}, "sess_xyz"),
        ("session_sealed", 409, {"id": "sess_42"}, "sess_42"),
        ("artifact_expired", 410, {"id": "art_x", "expires_at": "2026-01-01"}, "2026-01-01"),
        ("artifact_already_deleted", 410, {"id": "art_x", "deleted_at": "2026-02-02"}, "2026-02-02"),
        ("file_too_large", 413, None, "request_upload_url"),
        ("upload_not_found", 404, {"id": "art_x"}, "have not arrived"),
    ],
)
def test_round_trip_for_taxonomy_code(code, status, extra_vars, expected_in_text):
    failure = HttpFailure(error=HttpErrorBody(code=code, message="testmsg", status=status))
    result = translate_http_failure(failure, "any_tool", extra_vars)
    assert result["isError"] is True
    assert result["_meta"]["code"] == code
    assert result["_meta"]["status"] == status
    assert result["_meta"]["retry_hint"] == "do_not_retry"
    text = result["content"][0]["text"]
    assert expected_in_text in text


def test_unauthorized_uses_auth_remediation_template():
    failure = HttpFailure(error=HttpErrorBody(code="unauthorized", message="missing key", status=401))
    result = translate_http_failure(failure)
    text = result["content"][0]["text"]
    assert "Artifacta authentication failed" in text
    assert "ARTIFACTA_API_KEY" in text
    assert "missing key" in text
    assert result["_meta"]["retry_hint"] == "do_not_retry"


def test_unauthorized_includes_cached_key_suffix_when_set():
    whoami_cache.cache_key_suffix("a1b2")
    failure = HttpFailure(error=HttpErrorBody(code="unauthorized", message="bad", status=401))
    text = translate_http_failure(failure)["content"][0]["text"]
    assert "****a1b2" in text


def test_tenant_suspended_routes_to_dedicated_summary():
    failure = HttpFailure(
        error=HttpErrorBody(code="unauthorized", message="account is suspended", status=403)
    )
    text = translate_http_failure(failure)["content"][0]["text"]
    assert text == TENANT_SUSPENDED_SUMMARY


def test_rate_limited_includes_retry_after_and_metadata():
    failure = HttpFailure(
        error=HttpErrorBody(code="rate_limited", message="slow down", status=429, retry_after=12)
    )
    result = translate_http_failure(failure)
    text = result["content"][0]["text"]
    assert "Rate limit hit" in text
    assert "12s" in text
    assert result["_meta"]["retry_hint"] == "retry_after"
    assert result["_meta"]["retry_after_seconds"] == 12


def test_5xx_returns_server_summary_with_retry_count():
    failure = HttpFailure(
        error=HttpErrorBody(code="server_error", message="upstream blew up", status=503),
        attempts=3,
    )
    result = translate_http_failure(failure)
    text = result["content"][0]["text"]
    assert "503" in text and "3 times" in text
    assert result["_meta"]["retry_hint"] == "retry_with_backoff"


def test_network_error_treated_as_5xx_for_retry_hint():
    failure = HttpFailure(
        error=HttpErrorBody(code="network_error", message="connect timeout", status=0),
        attempts=2,
    )
    result = translate_http_failure(failure)
    assert result["_meta"]["retry_hint"] == "retry_with_backoff"


def test_ambiguous_completion_routes_to_guidance():
    failure = HttpFailure(
        error=HttpErrorBody(code="server_error", message="mid-write", status=502),
        attempts=1,
        ambiguous_completion=True,
    )
    result = translate_http_failure(failure, "request_upload_url")
    text = result["content"][0]["text"]
    assert "Artifacta API failed mid-write on request_upload_url" in text
    assert "list_artifacts" in text
    assert result["_meta"]["retry_hint"] == "do_not_retry"


def test_quota_exceeded_template_fills_upgrade_url():
    failure = HttpFailure(
        error=HttpErrorBody(
            code="quota_exceeded",
            message="100k req/month exhausted",
            status=402,
            upgrade_url="https://app.artifacta.io/billing",
        )
    )
    result = translate_http_failure(failure)
    text = result["content"][0]["text"]
    assert "https://app.artifacta.io/billing" in text
    assert result["_meta"]["upgrade_url"] == "https://app.artifacta.io/billing"


def test_unknown_code_falls_through_to_generic_summary():
    failure = HttpFailure(error=HttpErrorBody(code="brand_new_code", message="oh no", status=418))
    text = translate_http_failure(failure)["content"][0]["text"]
    assert "Artifacta error (brand_new_code)" in text
    assert "oh no" in text


# ---------------------------------------------------------------------------
# SDK-exception → HttpFailure adapter
# ---------------------------------------------------------------------------


class _FakeAuthError(Exception):
    code = "unauthorized"
    message = "bad key"
    status = 401


def test_failure_from_sdk_error_reads_attributes():
    failure = failure_from_sdk_error(_FakeAuthError("bad key"))
    assert failure.error.code == "unauthorized"
    assert failure.error.status == 401


class AuthenticationError(Exception):
    pass  # no .code attribute — exercises the type-name fallback


def test_failure_from_sdk_error_infers_code_from_type_name():
    failure = failure_from_sdk_error(AuthenticationError("login required"))
    assert failure.error.code == "unauthorized"
