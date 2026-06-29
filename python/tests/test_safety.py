"""Unit tests for the safety registry + flags + audit emitter."""
from __future__ import annotations

from pathlib import Path

import pytest

from artifacta_mcp import safety
from artifacta_mcp.safety import (
    FilterOpts,
    SafetyFlags,
    ToolRegistration,
    clear_registry,
    emit_destructive_audit,
    get_filtered_tools,
    is_call_permitted,
    parse_safety_flags,
    register_tool,
    tool_annotations,
)
from artifacta_mcp.tools import register_all_tools


@pytest.fixture(autouse=True)
def _reset():
    clear_registry()
    yield
    clear_registry()


async def _noop_handler(_args, _ctx):
    return {"content": [{"type": "text", "text": "ok"}]}


def _make_reg(name: str, safety_class: safety.ToolSafety, *, always_confirm: bool = False) -> ToolRegistration:
    return ToolRegistration(
        name=name,
        description=f"desc-{name}",
        input_schema={
            "type": "object",
            "properties": {},
            "additionalProperties": False,
            "required": [],
        },
        safety=safety_class,
        handler=_noop_handler,
        always_confirm=always_confirm,
    )


# ---------------------------------------------------------------------------
# parse_safety_flags
# ---------------------------------------------------------------------------


def test_allow_destructive_from_argv_only(monkeypatch):
    monkeypatch.delenv("ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM", raising=False)
    flags = parse_safety_flags(["--allow-destructive"])
    assert flags == SafetyFlags(allow_destructive=True, write_confirm_required=False)


def test_allow_destructive_not_read_from_env(monkeypatch):
    # Security: --allow-destructive MUST NOT be settable via env (plan §5 Notes).
    monkeypatch.setenv("ALLOW_DESTRUCTIVE", "1")
    monkeypatch.delenv("ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM", raising=False)
    flags = parse_safety_flags([])
    assert flags.allow_destructive is False


def test_write_confirm_required_from_env(monkeypatch):
    monkeypatch.setenv("ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM", "1")
    flags = parse_safety_flags([])
    assert flags.write_confirm_required is True


def test_write_confirm_required_off_by_default(monkeypatch):
    monkeypatch.delenv("ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM", raising=False)
    flags = parse_safety_flags([])
    assert flags.write_confirm_required is False


# ---------------------------------------------------------------------------
# get_filtered_tools — matrix of four cells
# ---------------------------------------------------------------------------


def test_destructive_absent_for_noncompliant_client_without_flag():
    register_tool(_make_reg("delete_artifact", "destructive"))
    register_tool(_make_reg("whoami", "safe"))
    tools = get_filtered_tools(
        FilterOpts(has_confirmations=False, allow_destructive=False, write_confirm_required=False)
    )
    names = [t["name"] for t in tools]
    assert "delete_artifact" not in names
    assert "whoami" in names


def test_destructive_present_for_noncompliant_client_with_flag():
    register_tool(_make_reg("delete_artifact", "destructive"))
    tools = get_filtered_tools(
        FilterOpts(has_confirmations=False, allow_destructive=True, write_confirm_required=False)
    )
    names = [t["name"] for t in tools]
    assert "delete_artifact" in names
    # Non-compliant clients never get requiresConfirmation, even with --allow-destructive
    dt = next(t for t in tools if t["name"] == "delete_artifact")
    assert "requiresConfirmation" not in dt.get("_meta", {})


def test_destructive_present_for_compliant_client_with_requires_confirmation():
    register_tool(_make_reg("delete_artifact", "destructive"))
    tools = get_filtered_tools(
        FilterOpts(has_confirmations=True, allow_destructive=False, write_confirm_required=False)
    )
    dt = next(t for t in tools if t["name"] == "delete_artifact")
    assert dt["_meta"]["requiresConfirmation"] is True


def test_always_confirm_promotes_alwaysconfirm_tool_for_compliant():
    register_tool(_make_reg("create_download_link", "writeNonIdempotent", always_confirm=True))
    tools = get_filtered_tools(
        FilterOpts(has_confirmations=True, allow_destructive=False, write_confirm_required=False)
    )
    cdl = next(t for t in tools if t["name"] == "create_download_link")
    assert cdl["_meta"]["requiresConfirmation"] is True


def test_write_confirm_required_promotes_write_tools_for_compliant_only():
    register_tool(_make_reg("store_artifact", "writeIdempotent"))
    tools_compliant = get_filtered_tools(
        FilterOpts(has_confirmations=True, allow_destructive=False, write_confirm_required=True)
    )
    sa = next(t for t in tools_compliant if t["name"] == "store_artifact")
    assert sa["_meta"]["requiresConfirmation"] is True

    # Non-compliant: never promoted, even with the env flag on
    clear_registry()
    register_tool(_make_reg("store_artifact", "writeIdempotent"))
    tools_nc = get_filtered_tools(
        FilterOpts(has_confirmations=False, allow_destructive=False, write_confirm_required=True)
    )
    sa_nc = next(t for t in tools_nc if t["name"] == "store_artifact")
    assert "requiresConfirmation" not in sa_nc.get("_meta", {})


# ---------------------------------------------------------------------------
# is_call_permitted — call-time gate mirrors the list filter
# ---------------------------------------------------------------------------


def test_is_call_permitted_blocks_destructive_for_noncompliant_no_flag():
    reg = _make_reg("delete_artifact", "destructive")
    assert is_call_permitted(reg, has_confirmations=False, allow_destructive=False) is False


def test_is_call_permitted_allows_destructive_for_compliant():
    reg = _make_reg("delete_artifact", "destructive")
    assert is_call_permitted(reg, has_confirmations=True, allow_destructive=False) is True


def test_is_call_permitted_allows_destructive_with_flag_only():
    reg = _make_reg("delete_artifact", "destructive")
    assert is_call_permitted(reg, has_confirmations=False, allow_destructive=True) is True


def test_is_call_permitted_always_allows_safe_tools():
    reg = _make_reg("whoami", "safe")
    assert is_call_permitted(reg, has_confirmations=False, allow_destructive=False) is True


# ---------------------------------------------------------------------------
# emit_destructive_audit — stderr format + redaction + truncation
# ---------------------------------------------------------------------------


def test_audit_writes_to_stderr(capsys):
    emit_destructive_audit("delete_artifact", {"artifact_id": "art_abc123"})
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "[artifacta-mcp] destructive call: delete_artifact" in captured.err
    assert "no confirmation surface" in captured.err
    assert "art_abc123" in captured.err


def test_audit_redacts_secrets(capsys):
    emit_destructive_audit("any_tool", {"api_key": "ak_live_supersecret_abcd1234"})
    captured = capsys.readouterr()
    assert "ak_live_supersecret" not in captured.err
    assert "[REDACTED]" in captured.err


def test_audit_truncates_long_args(capsys):
    big = {"blob": "x" * 1000}
    emit_destructive_audit("any_tool", big)
    captured = capsys.readouterr()
    # Truncation marker "..." appears after 200 chars of args
    assert "..." in captured.err
    # And the raw payload tail is dropped
    assert "x" * 1000 not in captured.err


# ---------------------------------------------------------------------------
# tool_annotations — AF_MCP-REG-2 (parity with TS safety/registry.ts)
# ---------------------------------------------------------------------------

READ_TOOLS = {
    "whoami",
    "list_artifacts",
    "get_artifact",
    "get_artifact_download_url",
    "list_sessions",
}
WRITE_TOOLS = {"store_artifact", "request_upload_url", "complete_upload", "publish_artifact", "unpublish_artifact"}
DESTRUCTIVE_TOOLS = {"create_download_link", "delete_artifact", "seal_session"}
ALL_13 = READ_TOOLS | WRITE_TOOLS | DESTRUCTIVE_TOOLS


@pytest.mark.parametrize("name", sorted(READ_TOOLS))
def test_read_tools_annotations(name):
    assert tool_annotations(name, "safe") == {"readOnlyHint": True}


@pytest.mark.parametrize("name", sorted(WRITE_TOOLS - {"store_artifact"}))
def test_write_tools_annotations(name):
    assert tool_annotations(name, "writeNonIdempotent") == {"readOnlyHint": False}


def test_store_artifact_idempotent_hint():
    assert tool_annotations("store_artifact", "writeIdempotent") == {
        "readOnlyHint": False,
        "idempotentHint": True,
    }


@pytest.mark.parametrize("name", sorted(DESTRUCTIVE_TOOLS))
def test_destructive_tools_annotations(name):
    assert tool_annotations(name, "destructive") == {"destructiveHint": True}


def test_production_catalog_exposes_annotations_on_all_13_tools():
    register_all_tools()
    tools = get_filtered_tools(
        FilterOpts(has_confirmations=True, allow_destructive=True, write_confirm_required=False)
    )
    names = {t["name"] for t in tools}
    assert names == ALL_13
    for t in tools:
        assert "annotations" in t
        name = t["name"]
        if name in READ_TOOLS:
            assert t["annotations"] == {"readOnlyHint": True}
        elif name == "store_artifact":
            assert t["annotations"] == {"readOnlyHint": False, "idempotentHint": True}
        elif name in WRITE_TOOLS:
            assert t["annotations"] == {"readOnlyHint": False}
        else:
            assert t["annotations"] == {"destructiveHint": True}


def test_readme_contains_mcp_name_marker():
    readme = (Path(__file__).resolve().parents[1] / "README.md").read_text(encoding="utf-8")
    assert "mcp-name: io.artifacta/mcp" in readme
