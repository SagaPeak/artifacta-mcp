"""Tool wrapper smoke tests — exercise each handler with a mocked Client.

The goal is wrapper correctness:
- Schema shape (additionalProperties:false, required keys present).
- Each handler invokes the SDK method we expect with the args we expect.
- Successful returns are MCP-shaped (`content` + `structuredContent`).
- SDK exceptions translate via errors.translate_http_failure (isError + _meta).
- Local guard rails (id pattern, oneOf, base64 cap) short-circuit before any
  SDK call.
"""
from __future__ import annotations

import asyncio
import base64
import os
from dataclasses import dataclass
from unittest.mock import MagicMock

import jsonschema
import pytest
from artifacta.errors import (
    ArtifactaError,
    ArtifactDeletedError,
    ArtifactNotFoundError,
    QuotaExceededError,
    UploadNotFoundError,
)

from artifacta_mcp import allowlist, client_factory, safety
from artifacta_mcp.safety import ToolCallContext
from artifacta_mcp.tools import register_all_tools
from artifacta_mcp.tools._common import get_client

_ctx = ToolCallContext(request_id="req_test")


@dataclass
class _CallLog:
    method: str
    args: tuple
    kwargs: dict


class _FakeArtifact:
    def __init__(self, data: dict):
        self._data = data

    def to_dict(self) -> dict:
        return dict(self._data)


class _FakeListResult(dict):
    pass


class _FakeClient:
    """Stub for artifacta.Client — records calls, returns scripted responses."""

    def __init__(self):
        self.calls: list[_CallLog] = []
        # Per-method scripted responses. Set before invoking.
        self.whoami_response = _FakeArtifact(
            {
                "tenant_name": "t",
                "plan": "Pro",
                "api_key_last_4": "9z9z",
                "usage_requests_month": 0,
                "plan_requests_limit_month": 1000000,
                "usage_storage_bytes": 0,
                "plan_storage_limit_bytes": 0,
            }
        )
        self.get_response = _FakeArtifact(
            {
                "artifact_id": "art_aaaaaaaaaaaaaaaa",
                "filename": "x.bin",
                "content_type": "application/octet-stream",
                "size_bytes": 1,
                "content_hash": "abc",
                "created_at": "2026-05-28T00:00:00Z",
            }
        )
        self.push_response = _FakeArtifact(
            {
                "artifact_id": "art_bbbbbbbbbbbbbbbb",
                "filename": "x.bin",
                "content_type": "application/octet-stream",
                "size_bytes": 5,
                "content_hash": "h",
                "created_at": "2026-05-28T00:00:00Z",
            }
        )
        self.delete_response = {
            "artifact_id": "art_aaaaaaaaaaaaaaaa",
            "deleted": True,
            "deleted_at": "2026-05-28T00:00:00Z",
        }
        self.seal_response = _FakeArtifact(
            {
                "session_id": "ses_xyz",
                "status": "sealed",
                "sealed_at": "2026-05-28T00:00:00Z",
                "artifact_count": 3,
            }
        )
        self.link_response = _FakeArtifact(
            {
                "link_id": "lnk_aaaaaaaaaaaaaaaaaaaa",
                "url": "https://dl.artifacta.io/lnk_aaaaaaaaaaaaaaaaaaaa",
                "artifact_id": "art_aaaaaaaaaaaaaaaa",
                "expires_at": "2027-01-01T00:00:00Z",
                "created_at": "2026-05-28T00:00:00Z",
            }
        )
        self.request_upload_url_response = {
            "artifact_id": "art_cccccccccccccccc",
            "status": "pending",
            "upload_url": "https://r2.example/pre",
            "upload_expires_at": "2026-05-28T01:00:00Z",
            "upload_method": "PUT",
            "upload_headers": {"x-amz-meta-tenant": "t"},
        }
        self.complete_upload_response = {
            "artifact_id": "art_cccccccccccccccc",
            "filename": "x.bin",
            "content_type": "application/octet-stream",
            "size_bytes": 100,
            "content_hash": "h",
            "created_at": "2026-05-28T00:00:00Z",
        }
        # Per-method exception override. If set, handler raises it instead.
        self.raise_on: dict[str, Exception] = {}

    def _track(self, method: str, *args, **kwargs):
        self.calls.append(_CallLog(method, args, kwargs))

    def whoami(self):
        self._track("whoami")
        if "whoami" in self.raise_on:
            raise self.raise_on["whoami"]
        return self.whoami_response

    def get(self, artifact_id: str):
        self._track("get", artifact_id)
        if "get" in self.raise_on:
            raise self.raise_on["get"]
        return self.get_response

    def delete(self, artifact_id: str):
        self._track("delete", artifact_id)
        if "delete" in self.raise_on:
            raise self.raise_on["delete"]
        return self.delete_response

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
    ):
        # Mirrors the REAL SDK signature so a future drift in the call site
        # (e.g. wrong kwarg name) fails the test instead of being silently
        # swallowed by **kwargs.
        self._track(
            "push",
            path=path,
            content=content,
            filename=filename,
            content_type=content_type,
            session_id=session_id,
            agent_id=agent_id,
            metadata=metadata,
            ttl=ttl,
            idempotency_key=idempotency_key,
            presigned=presigned,
        )
        if "push" in self.raise_on:
            raise self.raise_on["push"]
        return self.push_response

    def create_link(self, *, artifact_id: str, expires_in: int):
        self._track("create_link", artifact_id=artifact_id, expires_in=expires_in)
        if "create_link" in self.raise_on:
            raise self.raise_on["create_link"]
        return self.link_response

    def seal_session(self, session_id: str):
        self._track("seal_session", session_id)
        if "seal_session" in self.raise_on:
            raise self.raise_on["seal_session"]
        return self.seal_response

    def request_upload_url(self, **kwargs):
        self._track("request_upload_url", **kwargs)
        if "request_upload_url" in self.raise_on:
            raise self.raise_on["request_upload_url"]
        return self.request_upload_url_response

    def complete_upload(self, artifact_id: str):
        self._track("complete_upload", artifact_id)
        if "complete_upload" in self.raise_on:
            raise self.raise_on["complete_upload"]
        return self.complete_upload_response

    # ListArtifacts and ListSessions both call _request directly.
    def _request(self, method: str, path: str, **kwargs):
        self._track("_request", method, path, **kwargs)
        if "_request" in self.raise_on:
            raise self.raise_on["_request"]

        class _Resp:
            def __init__(self, body):
                self._body = body

            def json(self):
                return self._body

        if path == "/v1/artifacts":
            return _Resp({"artifacts": [self.get_response.to_dict()], "has_more": False, "next_cursor": None})
        if path.endswith("/download-url"):
            return _Resp(
                {
                    "download_url": "https://r2.example/dl",
                    "expires_in": 3600,
                    "filename": "x.bin",
                    "content_type": "application/octet-stream",
                    "size_bytes": 1,
                }
            )
        if path == "/v1/sessions":
            return _Resp(
                {
                    "sessions": [
                        {
                            "session_id": "ses_a",
                            "artifact_count": 1,
                            "is_sealed": False,
                            "first_artifact_at": "2026-05-28T00:00:00Z",
                            "last_artifact_at": "2026-05-28T00:00:00Z",
                        }
                    ],
                    "has_more": False,
                    "next_cursor": None,
                }
            )
        return _Resp({})


@pytest.fixture
def fake_client():
    client = _FakeClient()
    client_factory.set_client(client)
    safety.clear_registry()
    register_all_tools()
    yield client
    client_factory.reset_client()
    safety.clear_registry()


def _call(name: str, args: dict | None = None) -> dict:
    reg = safety.get_tool_registration(name)
    assert reg is not None, f"tool {name} not registered"
    ctx = ToolCallContext(request_id="req_test")
    return asyncio.run(reg.handler(args, ctx))


def _assert_mcp_ok_shape(result: dict, payload_must_contain: str | None = None) -> None:
    assert "isError" not in result or result["isError"] is False
    content = result.get("content") or []
    assert content and content[0]["type"] == "text"
    if payload_must_contain is not None:
        assert payload_must_contain in content[0]["text"]


def _assert_mcp_err_shape(result: dict, code: str) -> None:
    assert result.get("isError") is True
    assert result["_meta"]["code"] == code


# ---------------------------------------------------------------------------
# Registration / schema invariants
# ---------------------------------------------------------------------------


def test_all_13_tools_registered(fake_client):
    names = sorted(r.name for r in safety.all_registrations())
    assert names == sorted(
        [
            "whoami",
            "list_artifacts",
            "get_artifact",
            "get_artifact_download_url",
            "list_sessions",
            "store_artifact",
            "request_upload_url",
            "complete_upload",
            "create_download_link",
            "delete_artifact",
            "seal_session",
            "publish_artifact",
            "unpublish_artifact",
        ]
    )


def test_every_tool_schema_disallows_additional_properties(fake_client):
    for reg in safety.all_registrations():
        schema = reg.input_schema
        assert schema.get("type") == "object", f"{reg.name}: type missing"
        assert schema.get("additionalProperties") is False, (
            f"{reg.name}: additionalProperties must be False"
        )
        # Required is always a list — even when empty.
        assert isinstance(schema.get("required", []), list)


def test_every_tool_schema_is_valid_json_schema(fake_client):
    for reg in safety.all_registrations():
        # Compiles without raising → schema is itself well-formed
        jsonschema.Draft202012Validator.check_schema(reg.input_schema)


def test_safety_classification_matches_spec(fake_client):
    spec = {
        "whoami": "safe",
        "list_artifacts": "safe",
        "get_artifact": "safe",
        "get_artifact_download_url": "safe",
        "list_sessions": "safe",
        "store_artifact": "writeIdempotent",
        "request_upload_url": "writeNonIdempotent",
        "complete_upload": "writeIdempotent",
        "create_download_link": "destructive",
        "delete_artifact": "destructive",
        "seal_session": "destructive",
        "publish_artifact": "writeIdempotent",
        "unpublish_artifact": "writeIdempotent",
    }
    for reg in safety.all_registrations():
        assert reg.safety == spec[reg.name], reg.name


# ---------------------------------------------------------------------------
# Happy-path per tool
# ---------------------------------------------------------------------------


def test_whoami_returns_mcp_payload(fake_client):
    result = _call("whoami")
    _assert_mcp_ok_shape(result, "tenant_name")
    # Side-effect: cache_key_suffix populated
    from artifacta_mcp import whoami_cache

    assert whoami_cache.get_cached_key_suffix() == "9z9z"


def test_get_artifact_calls_sdk_with_id(fake_client):
    result = _call("get_artifact", {"artifact_id": "art_aaaaaaaaaaaaaaaa"})
    _assert_mcp_ok_shape(result, "art_aaaaaaaaaaaaaaaa")
    assert fake_client.calls[0].method == "get"
    assert fake_client.calls[0].args == ("art_aaaaaaaaaaaaaaaa",)


def test_get_artifact_local_guard_for_missing_id(fake_client):
    # The TS handler (and our port) only runtime-checks `isinstance(str)`;
    # pattern validation is the schema's job. Verify the type guard fires.
    result = _call("get_artifact", {"artifact_id": 42})
    _assert_mcp_err_shape(result, "invalid_request")
    assert fake_client.calls == []


def test_get_artifact_schema_rejects_bad_id_pattern(fake_client):
    schema = safety.get_tool_registration("get_artifact").input_schema
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({"artifact_id": "bogus"}, schema)


def test_complete_upload_handler_runtime_pattern_check(fake_client):
    # complete_upload, delete_artifact, seal_session DO runtime pattern-check
    # (defence-in-depth for non-compliant clients).
    result = _call("complete_upload", {"artifact_id": "bogus"})
    _assert_mcp_err_shape(result, "invalid_request")
    assert fake_client.calls == []


def test_get_artifact_translates_not_found_with_id(fake_client):
    fake_client.raise_on["get"] = ArtifactNotFoundError("missing")
    result = _call("get_artifact", {"artifact_id": "art_aaaaaaaaaaaaaaaa"})
    _assert_mcp_err_shape(result, "artifact_not_found")
    assert "art_aaaaaaaaaaaaaaaa" in result["content"][0]["text"]


def test_list_artifacts_forwards_filters(fake_client):
    _call(
        "list_artifacts",
        {
            "session_id": "ses_a",
            "filename": "out.json",
            "metadata": {"job": "j-1"},
            "limit": 25,
        },
    )
    last = fake_client.calls[-1]
    assert last.method == "_request"
    assert last.args == ("GET", "/v1/artifacts")
    params = last.kwargs["params"]
    assert params["session_id"] == "ses_a"
    assert params["filename"] == "out.json"
    assert params["metadata.job"] == "j-1"
    assert params["limit"] == 25


def test_get_artifact_download_url_calls_endpoint(fake_client):
    result = _call("get_artifact_download_url", {"artifact_id": "art_aaaaaaaaaaaaaaaa"})
    _assert_mcp_ok_shape(result, "download_url")
    last = fake_client.calls[-1]
    assert last.args[1].endswith("/download-url")


def test_list_sessions_translates_cursor_to_after(fake_client):
    _call("list_sessions", {"cursor": "opaque-cursor", "limit": 10})
    last = fake_client.calls[-1]
    assert last.kwargs["params"]["after"] == "opaque-cursor"
    assert last.kwargs["params"]["limit"] == 10


def test_store_artifact_content_branch_pushes_bytes(fake_client):
    payload = base64.b64encode(b"hello world").decode()
    result = _call("store_artifact", {"filename": "hello.txt", "content": payload})
    _assert_mcp_ok_shape(result, "art_bbbbbbbbbbbbbbbb")
    last = fake_client.calls[-1]
    assert last.method == "push"
    # Real SDK kwargs (path=None, content=bytes, filename=str) — no temp file dance.
    assert last.kwargs["path"] is None
    assert last.kwargs["content"] == b"hello world"
    assert last.kwargs["filename"] == "hello.txt"
    # Idempotency-Key auto-injected and surfaced in _meta
    assert result["_meta"]["idempotency_key"].startswith("mcp_")


def test_store_artifact_defaults_agent_id_to_mcp_when_no_client_name(fake_client):
    payload = base64.b64encode(b"hello world").decode()
    result = _call("store_artifact", {"filename": "hello.txt", "content": payload})
    _assert_mcp_ok_shape(result, "art_bbbbbbbbbbbbbbbb")
    last = fake_client.calls[-1]
    assert last.kwargs["agent_id"] == "mcp"


def test_store_artifact_defaults_agent_id_to_client_name(fake_client):
    reg = safety.get_tool_registration("store_artifact")
    ctx = ToolCallContext(request_id="req_test", client_name="claude-code")
    payload = base64.b64encode(b"hello world").decode()
    result = asyncio.run(reg.handler({"filename": "hello.txt", "content": payload}, ctx))
    _assert_mcp_ok_shape(result, "art_bbbbbbbbbbbbbbbb")
    last = fake_client.calls[-1]
    assert last.kwargs["agent_id"] == "claude-code"


def test_store_artifact_explicit_agent_id_wins_over_client_name(fake_client):
    reg = safety.get_tool_registration("store_artifact")
    ctx = ToolCallContext(request_id="req_test", client_name="claude-code")
    payload = base64.b64encode(b"hello world").decode()
    result = asyncio.run(
        reg.handler(
            {"filename": "hello.txt", "content": payload, "agent_id": "agent-prod"}, ctx
        )
    )
    _assert_mcp_ok_shape(result, "art_bbbbbbbbbbbbbbbb")
    last = fake_client.calls[-1]
    assert last.kwargs["agent_id"] == "agent-prod"


def test_store_artifact_model_shorthand_folds_into_metadata(fake_client):
    payload = base64.b64encode(b"hello world").decode()
    result = _call(
        "store_artifact", {"filename": "hello.txt", "content": payload, "model": "claude-5"}
    )
    _assert_mcp_ok_shape(result, "art_bbbbbbbbbbbbbbbb")
    last = fake_client.calls[-1]
    assert last.kwargs["metadata"] == {"model": "claude-5"}


def test_store_artifact_explicit_metadata_model_wins_over_shorthand(fake_client):
    payload = base64.b64encode(b"hello world").decode()
    result = _call(
        "store_artifact",
        {
            "filename": "hello.txt",
            "content": payload,
            "model": "claude-5",
            "metadata": {"model": "gpt-5.5", "stage": "final"},
        },
    )
    _assert_mcp_ok_shape(result, "art_bbbbbbbbbbbbbbbb")
    last = fake_client.calls[-1]
    assert last.kwargs["metadata"] == {"model": "gpt-5.5", "stage": "final"}


def test_store_artifact_rejects_non_string_model(fake_client):
    result = _call("store_artifact", {"filename": "f", "content": "Zg==", "model": 5})
    _assert_mcp_err_shape(result, "invalid_request")
    assert fake_client.calls == []


def test_store_artifact_rejects_both_content_and_path(fake_client):
    result = _call(
        "store_artifact",
        {"filename": "f", "content": "Zg==", "path": "/tmp/whatever"},
    )
    _assert_mcp_err_shape(result, "invalid_request")
    assert fake_client.calls == []


def test_store_artifact_rejects_missing_both(fake_client):
    result = _call("store_artifact", {"filename": "f"})
    _assert_mcp_err_shape(result, "invalid_request")
    assert fake_client.calls == []


def test_store_artifact_content_above_cap_rejected(fake_client):
    big = base64.b64encode(b"x" * (10 * 1024 * 1024 + 1)).decode()
    result = _call("store_artifact", {"filename": "f", "content": big})
    _assert_mcp_err_shape(result, "invalid_request")


def test_store_artifact_path_branch_with_confinement(fake_client, tmp_path, monkeypatch):
    f = tmp_path / "in.bin"
    f.write_bytes(b"abcdef")
    allowlist.set_allow_roots([os.path.realpath(str(tmp_path))])
    result = _call("store_artifact", {"filename": "in.bin", "path": str(f)})
    _assert_mcp_ok_shape(result, "art_bbbbbbbbbbbbbbbb")
    last = fake_client.calls[-1]
    assert last.method == "push"
    # The TOCTOU-safe path: the wrapper reads bytes from the validated fd and
    # passes them via `content=`. The raw `path=` kwarg must NOT be set —
    # the SDK must never re-open the path string after check_path returned.
    assert last.kwargs["path"] is None
    assert last.kwargs["content"] == b"abcdef"
    assert last.kwargs["filename"] == "in.bin"


def test_store_artifact_path_branch_denies_outside_allow_list(fake_client, tmp_path):
    # CWD-only allow-list; pass a path outside it.
    other = tmp_path / "elsewhere"
    other.mkdir()
    f = other / "in.bin"
    f.write_bytes(b"hi")
    allowlist.set_allow_roots([os.path.realpath(str(tmp_path / "allowed"))])
    (tmp_path / "allowed").mkdir(exist_ok=True)
    result = _call("store_artifact", {"filename": "in.bin", "path": str(f)})
    _assert_mcp_err_shape(result, "invalid_request")
    assert fake_client.calls == []


def test_store_artifact_path_branch_rejects_in_place_swap_between_check_and_upload(
    fake_client, tmp_path
):
    """TOCTOU regression for the Codex finding.

    Under the OLD code path:
      check_path() returned an open fd as TOCTOU protection.
      The handler discarded the fd and called client.push(file_path=...)
      which inside the SDK did Path(path).read_bytes() — a fresh open.
      An attacker who could mutate the allowed directory between
      check_path() returning and Path.read_bytes() opening could swap the
      file (e.g. truncate-and-rewrite via `open(path, "wb")` keeps the
      same dirent inode), and the swapped bytes would reach the API.

    Under the FIXED code path:
      The handler reads bytes through the validated fd and re-fstats the
      still-open fd after the read. If size or mtime drifted between
      check_path()'s fstat and the post-read fstat, the upload is refused
      with `invalid_request`. The hostile bytes never reach the SDK.

    We simulate the attack by wrapping check_path with a hook that
    rewrites the file in place after check_path returns but before the
    handler reads. With the fix, this MUST be rejected; the SDK's push
    MUST NOT be called.
    """
    safe = tmp_path / "innocent.txt"
    safe.write_bytes(b"this is safe content")
    allowlist.set_allow_roots([os.path.realpath(str(tmp_path))])

    import artifacta_mcp.tools.store_artifact as sa
    real_check_path = sa.path_confinement.check_path

    def evil_check_path(input_path, allow_roots, ceiling_bytes=None):
        if ceiling_bytes is None:
            result = real_check_path(input_path, allow_roots)
        else:
            result = real_check_path(input_path, allow_roots, ceiling_bytes)
        # In-place truncate-and-rewrite. `Path.write_bytes` uses O_TRUNC
        # which preserves the inode but bumps mtime — the tripwire we
        # land in store_artifact.py catches this and refuses.
        # Sleep a millisecond so mtime resolution actually advances on
        # filesystems with second-or-coarser timestamps.
        import time
        time.sleep(0.05)
        safe.write_bytes(b"HOSTILE_CONTENT_FROM_ATTACKER")
        return result

    sa.path_confinement.check_path = evil_check_path
    try:
        result = _call("store_artifact", {"filename": "innocent.txt", "path": str(safe)})
    finally:
        sa.path_confinement.check_path = real_check_path

    _assert_mcp_err_shape(result, "invalid_request")
    assert "modified during the confinement" in result["content"][0]["text"]
    # The SDK push() MUST NOT have been called — hostile bytes never reach the wire.
    assert all(c.method != "push" for c in fake_client.calls), (
        f"TOCTOU regression: SDK push was invoked despite mid-window mutation "
        f"(call log: {[c.method for c in fake_client.calls]})"
    )


def test_store_artifact_path_branch_quiet_upload_with_no_swap(fake_client, tmp_path):
    """Sanity-check the non-attacker path: when nothing modifies the file
    between check_path and the read, the upload proceeds and the bytes
    reaching the SDK match the validated bytes exactly.
    """
    safe = tmp_path / "ok.bin"
    safe.write_bytes(b"this is safe content")
    allowlist.set_allow_roots([os.path.realpath(str(tmp_path))])
    result = _call("store_artifact", {"filename": "ok.bin", "path": str(safe)})
    _assert_mcp_ok_shape(result)
    last = fake_client.calls[-1]
    assert last.method == "push"
    assert last.kwargs["content"] == b"this is safe content"
    assert last.kwargs["path"] is None


def test_request_upload_url_validates_size_bytes(fake_client):
    result = _call(
        "request_upload_url",
        {"filename": "big.bin", "content_type": "application/octet-stream", "size_bytes": 0},
    )
    _assert_mcp_err_shape(result, "invalid_request")


def test_request_upload_url_happy_path(fake_client):
    result = _call(
        "request_upload_url",
        {
            "filename": "big.bin",
            "content_type": "application/octet-stream",
            "size_bytes": 600 * 1024 * 1024,
        },
    )
    _assert_mcp_ok_shape(result, "upload_url")
    last = fake_client.calls[-1]
    assert last.method == "request_upload_url"


def test_request_upload_url_5xx_surfaces_ambiguous_completion(fake_client):
    err = ArtifactaError(code="server_error", message="upstream blew up", status=502)
    fake_client.raise_on["request_upload_url"] = err
    result = _call(
        "request_upload_url",
        {
            "filename": "big.bin",
            "content_type": "application/octet-stream",
            "size_bytes": 600 * 1024 * 1024,
        },
    )
    assert result["isError"] is True
    text = result["content"][0]["text"]
    assert "failed mid-write on request_upload_url" in text


def test_complete_upload_calls_endpoint(fake_client):
    result = _call("complete_upload", {"artifact_id": "art_cccccccccccccccc"})
    _assert_mcp_ok_shape(result, "art_cccccccccccccccc")
    assert fake_client.calls[-1].method == "complete_upload"


def test_complete_upload_upload_not_found_includes_id(fake_client):
    fake_client.raise_on["complete_upload"] = UploadNotFoundError("not yet")
    result = _call("complete_upload", {"artifact_id": "art_cccccccccccccccc"})
    _assert_mcp_err_shape(result, "upload_not_found")
    assert "art_cccccccccccccccc" in result["content"][0]["text"]


def test_create_download_link_default_expiry(fake_client):
    result = _call("create_download_link", {"artifact_id": "art_aaaaaaaaaaaaaaaa"})
    _assert_mcp_ok_shape(result, "lnk_aaaaaaaaaaaaaaaaaaaa")
    last = fake_client.calls[-1]
    assert last.method == "create_link"
    assert last.kwargs["expires_in"] == 604800


def test_create_download_link_respects_explicit_expiry(fake_client):
    _call(
        "create_download_link",
        {"artifact_id": "art_aaaaaaaaaaaaaaaa", "expires_in": 3600},
    )
    assert fake_client.calls[-1].kwargs["expires_in"] == 3600


def test_create_download_link_quota_exceeded_translates(fake_client):
    exc = QuotaExceededError("500 links cap")
    # Attach upgrade_url so the error template renders it.
    exc.upgrade_url = "https://app.artifacta.io/billing"
    fake_client.raise_on["create_link"] = exc
    result = _call(
        "create_download_link",
        {"artifact_id": "art_aaaaaaaaaaaaaaaa", "expires_in": 3600},
    )
    _assert_mcp_err_shape(result, "quota_exceeded")
    assert "https://app.artifacta.io/billing" in result["content"][0]["text"]


def test_delete_artifact_success(fake_client):
    result = _call("delete_artifact", {"artifact_id": "art_aaaaaaaaaaaaaaaa"})
    _assert_mcp_ok_shape(result, "deleted")


def test_delete_artifact_replay_returns_already_deleted(fake_client):
    fake_client.raise_on["delete"] = ArtifactDeletedError("already gone")
    result = _call("delete_artifact", {"artifact_id": "art_aaaaaaaaaaaaaaaa"})
    _assert_mcp_ok_shape(result, "already_deleted")
    # The structured content carries the replay shape
    sc = result.get("structuredContent") or {}
    assert sc.get("already_deleted") is True


def test_seal_session_success(fake_client):
    result = _call("seal_session", {"session_id": "ses_xyz"})
    _assert_mcp_ok_shape(result, "sealed")


def test_seal_session_rejects_bad_id(fake_client):
    result = _call("seal_session", {"session_id": "/etc/passwd"})
    _assert_mcp_err_shape(result, "invalid_request")
    assert fake_client.calls == []


# ---------------------------------------------------------------------------
# publish_artifact / unpublish_artifact
# ---------------------------------------------------------------------------


def test_publish_artifact_no_password_param():
    from artifacta_mcp.tools.publish_artifact import INPUT_SCHEMA

    assert "password" not in INPUT_SCHEMA["properties"]
    assert "artifact_id" in INPUT_SCHEMA["required"]


def test_publish_artifact_schema_has_visibility_and_access():
    from artifacta_mcp.tools.publish_artifact import INPUT_SCHEMA

    props = INPUT_SCHEMA["properties"]
    assert props["visibility"]["enum"] == ["unlisted", "public"]
    assert props["access"]["enum"] == ["none", "password"]


def test_publish_artifact_calls_sdk(fake_client):
    from artifacta_mcp.tools.publish_artifact import handler

    client = get_client()
    client.publish_artifact = MagicMock(
        return_value={
            "page_id": "pg_x",
            "public_url": "https://artifacta.io/a/pg_x",
            "visibility": "unlisted",
            "access": "none",
        }
    )
    result = asyncio.run(handler({"artifact_id": "art_x"}, _ctx))
    assert not result.get("isError")
    assert "pg_x" in result["content"][0]["text"]
    client.publish_artifact.assert_called_once()


def test_publish_artifact_missing_id_returns_invalid_request(fake_client):
    from artifacta_mcp.tools.publish_artifact import handler

    result = asyncio.run(handler({}, _ctx))
    assert result.get("isError") is True
    assert result["_meta"]["code"] == "invalid_request"


def test_publish_artifact_defaults_visibility_and_access(fake_client):
    from artifacta_mcp.tools.publish_artifact import handler

    client = get_client()
    client.publish_artifact = MagicMock(
        return_value={
            "page_id": "pg_d",
            "public_url": "https://artifacta.io/a/pg_d",
            "visibility": "unlisted",
            "access": "none",
        }
    )
    asyncio.run(handler({"artifact_id": "art_d"}, _ctx))
    call_kwargs = client.publish_artifact.call_args
    assert call_kwargs.kwargs.get("visibility") == "unlisted"
    assert call_kwargs.kwargs.get("access") == "none"


def test_unpublish_artifact_calls_sdk(fake_client):
    from artifacta_mcp.tools.unpublish_artifact import handler

    client = get_client()
    client.unpublish = MagicMock(return_value={"page_id": "pg_x", "unpublished": True})
    result = asyncio.run(handler({"artifact_id": "art_x"}, _ctx))
    assert not result.get("isError")
    assert "pg_x" in result["content"][0]["text"]
    client.unpublish.assert_called_once_with("art_x")


def test_unpublish_artifact_missing_id_returns_invalid_request(fake_client):
    from artifacta_mcp.tools.unpublish_artifact import handler

    result = asyncio.run(handler({}, _ctx))
    assert result.get("isError") is True
    assert result["_meta"]["code"] == "invalid_request"
