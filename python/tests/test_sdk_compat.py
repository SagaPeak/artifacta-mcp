"""Tests for the runtime SDK compatibility check (sdk_compat.py)."""
from __future__ import annotations

import inspect

import pytest
from artifacta import Client as RealClient

from artifacta_mcp.sdk_compat import (
    REQUIRED_CLIENT_METHODS,
    REQUIRED_PUSH_KWARGS,
    check_sdk_compatibility,
)
from tests.conftest import HAS_TRANSCRIPT_CAPABILITY, TRANSCRIPT_CAPABILITY_SKIP_REASON

# ---------------------------------------------------------------------------
# Happy path — against the real installed SDK
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not HAS_TRANSCRIPT_CAPABILITY, reason=TRANSCRIPT_CAPABILITY_SKIP_REASON)
def test_real_client_passes_compat_check():
    assert check_sdk_compatibility(RealClient) is None


def test_real_client_has_every_required_method():
    for name in REQUIRED_CLIENT_METHODS:
        assert hasattr(RealClient, name), f"Real Client missing {name!r}"


@pytest.mark.skipif(not HAS_TRANSCRIPT_CAPABILITY, reason=TRANSCRIPT_CAPABILITY_SKIP_REASON)
def test_real_client_push_has_every_required_kwarg():
    sig = inspect.signature(RealClient.push)
    for kw in REQUIRED_PUSH_KWARGS:
        assert kw in sig.parameters, f"Real Client.push missing {kw!r}"


# ---------------------------------------------------------------------------
# Negative paths — stub Clients that simulate an older SDK
# ---------------------------------------------------------------------------


def _make_full_client_stub() -> type:
    """Build a stub Client class with every required method + push kwarg.

    Tests below remove one piece at a time to verify the check detects each
    specific kind of incompatibility.
    """
    class StubClient:
        def __init__(self, *, api_key=None, base_url=None):
            self.api_key = api_key
            self.base_url = base_url

        def whoami(self): ...
        def push(
            self,
            path=None,
            *,
            content=None,
            filename=None,
            content_type=None,
            session_id=None,
            agent_id=None,
            metadata=None,
            ttl=None,
            idempotency_key=None,
            presigned=False,
            transcript=False,
        ): ...
        def get(self, artifact_id): ...
        def delete(self, artifact_id): ...
        def create_link(self, *, artifact_id, expires_in): ...
        def list_sessions(self, **kwargs): ...
        def seal_session(self, session_id): ...
        def request_upload_url(self, **kwargs): ...
        def complete_upload(self, artifact_id): ...

    return StubClient


def test_compat_check_passes_on_full_stub():
    StubClient = _make_full_client_stub()
    assert check_sdk_compatibility(StubClient) is None


@pytest.mark.parametrize("missing_method", list(REQUIRED_CLIENT_METHODS))
def test_compat_check_detects_each_missing_method(missing_method):
    StubClient = _make_full_client_stub()
    delattr(StubClient, missing_method)
    error = check_sdk_compatibility(StubClient)
    assert error is not None
    assert missing_method in error
    assert "missing required Client method" in error
    assert "pip install --upgrade 'artifacta-cli>=0.3.0" in error


def test_compat_check_detects_old_push_without_content_type_kwarg():
    """This is the exact regression Codex flagged: artifacta-cli 0.2.0
    has Client.push but the signature lacks content_type. Calling it
    with content_type=... would TypeError at first store_artifact call.
    """
    class OldPushClient(_make_full_client_stub()):
        def push(
            self,
            path=None,
            *,
            content=None,
            filename=None,
            # No content_type kwarg — simulates artifacta-cli <= 0.2.0
            session_id=None,
            agent_id=None,
            metadata=None,
            ttl=None,
            idempotency_key=None,
            presigned=False,
        ): ...

    error = check_sdk_compatibility(OldPushClient)
    assert error is not None
    assert "content_type" in error
    assert "push()" in error
    assert "missing required parameter" in error


def test_compat_check_detects_push_without_transcript_kwarg():
    class PreTranscriptClient(_make_full_client_stub()):
        def push(
            self,
            path=None,
            *,
            content=None,
            filename=None,
            content_type=None,
            session_id=None,
            agent_id=None,
            metadata=None,
            ttl=None,
            idempotency_key=None,
            presigned=False,
        ): ...

    error = check_sdk_compatibility(PreTranscriptClient)
    assert error is not None
    assert "transcript" in error
    assert "push()" in error


def test_compat_check_detects_old_sdk_missing_request_upload_url():
    """Simulates artifacta-cli 0.2.0, which lacked request_upload_url and
    complete_upload entirely (they were added as public methods in 0.3.0).
    """
    StubClient = _make_full_client_stub()
    delattr(StubClient, "request_upload_url")
    delattr(StubClient, "complete_upload")
    error = check_sdk_compatibility(StubClient)
    assert error is not None
    # The check reports the first missing one it encounters from the list;
    # `request_upload_url` is listed before `complete_upload`.
    assert "request_upload_url" in error


def test_error_message_actionable():
    """Operator should be able to copy-paste the upgrade hint."""
    StubClient = _make_full_client_stub()
    delattr(StubClient, "whoami")
    error = check_sdk_compatibility(StubClient)
    assert error is not None
    # Self-contained: starts with the prefix, includes hint, ends with period.
    assert error.startswith("[artifacta-mcp] refusing to start:")
    assert "Upgrade with:" in error
    assert "pipx upgrade artifacta-mcp" in error
