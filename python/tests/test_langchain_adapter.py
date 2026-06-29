"""Tests for the LangChain adapter (artifacta_mcp.langchain).

These require `langchain-core` (in the `dev` extra so CI installs it).

The schema-fidelity tests are driven from the **real** registered MCP tool
catalog (``safety.get_filtered_tools``), not hand-written mocks: a mock catalog
gives false confidence because it can drift from the real `inputSchema`
(`oneOf` / required arrays) the server actually advertises (Codex finding). The
``test_real_stdio_*`` test additionally spawns the real server over stdio and
asserts the LangChain tools match the live ``tools/list`` payload end-to-end.
"""
from __future__ import annotations

import asyncio

import pytest

from artifacta_mcp import langchain as lc_adapter
from artifacta_mcp import safety
from artifacta_mcp.tools import register_all_tools

StructuredTool = pytest.importorskip("langchain_core.tools").StructuredTool
ToolException = pytest.importorskip("langchain_core.tools").ToolException


# --------------------------------------------------------------------------
# The REAL MCP tool catalog — the exact `tools/list` payload the server emits
# (all 13 tools; `allow_destructive=True` so the destructive ones are present).
# Each entry is a `{name, description, inputSchema, ...}` dict, which the
# adapter consumes directly (see test_dict_descriptor_supported).
# --------------------------------------------------------------------------

def _real_tool_catalog() -> list[dict]:
    # Snapshot + restore the global registry so importing this module never
    # leaves it in a different state than it found it (order-independence under
    # pytest-randomly / arbitrary collection order).
    saved = safety.all_registrations()
    try:
        safety.clear_registry()
        register_all_tools()
        return safety.get_filtered_tools(
            safety.FilterOpts(
                has_confirmations=False,
                allow_destructive=True,
                write_confirm_required=False,
            )
        )
    finally:
        safety.clear_registry()
        for reg in saved:
            safety.register_tool(reg)


ALL_13_TOOLS = _real_tool_catalog()
_BY_NAME = {t["name"]: t for t in ALL_13_TOOLS}

EXPECTED_TOOL_NAMES = {
    "whoami", "list_artifacts", "get_artifact", "get_artifact_download_url",
    "list_sessions", "store_artifact", "request_upload_url", "complete_upload",
    "create_download_link", "delete_artifact", "seal_session",
    "publish_artifact", "unpublish_artifact",
}


class _RecordingCallTool:
    """Async MCP dispatcher mock — records (name, args) and returns scripted."""

    def __init__(self, response="ok"):
        self.calls: list[tuple[str, dict]] = []
        self.response = response

    async def __call__(self, name: str, arguments: dict):
        self.calls.append((name, arguments))
        return self.response


# --------------------------------------------------------------------------
# Sanity: the real catalog actually has all 13 tools (otherwise every
# fidelity assertion below would be vacuously testing a short list).
# --------------------------------------------------------------------------

def test_real_catalog_has_all_13_tools():
    assert len(ALL_13_TOOLS) == 13
    assert {t["name"] for t in ALL_13_TOOLS} == EXPECTED_TOOL_NAMES


# --------------------------------------------------------------------------
# to_langchain_tools — wrapping logic driven by the real catalog
# --------------------------------------------------------------------------

def test_handles_all_13_tools():
    tools = lc_adapter.to_langchain_tools(ALL_13_TOOLS, _RecordingCallTool())
    assert len(tools) == 13
    assert {t.name for t in tools} == EXPECTED_TOOL_NAMES


def test_each_item_is_structured_tool():
    tools = lc_adapter.to_langchain_tools(ALL_13_TOOLS, _RecordingCallTool())
    assert all(isinstance(t, StructuredTool) for t in tools)


def test_whoami_present():
    tools = lc_adapter.to_langchain_tools(ALL_13_TOOLS, _RecordingCallTool())
    assert "whoami" in {t.name for t in tools}


def test_schema_fidelity_for_every_tool():
    """Each StructuredTool must mirror the real MCP descriptor exactly —
    name, description, and the full inputSchema (including `oneOf` / `required`),
    not a simplified approximation. This is the assertion that catches a
    renamed tool, a dropped required field, or a lost `oneOf` constraint."""
    tools = {t.name: t for t in lc_adapter.to_langchain_tools(ALL_13_TOOLS, _RecordingCallTool())}
    assert set(tools) == EXPECTED_TOOL_NAMES
    for name, descriptor in _BY_NAME.items():
        st = tools[name]
        assert st.name == descriptor["name"]
        assert st.description == descriptor["description"]
        # args_schema is the MCP inputSchema verbatim (StructuredTool keeps a
        # raw JSON-schema dict as-is), so this compares the whole shape.
        assert st.args_schema == descriptor["inputSchema"]


def test_store_artifact_schema_keeps_required_and_oneof():
    """Regression for the specific drift Codex flagged: the old mock omitted
    store_artifact's required `filename` and its content/path `oneOf`."""
    st = {t.name: t for t in lc_adapter.to_langchain_tools(ALL_13_TOOLS, _RecordingCallTool())}[
        "store_artifact"
    ]
    schema = st.args_schema
    assert schema["required"] == ["filename"]
    assert "oneOf" in schema  # the content/path mutual-exclusion constraint


def test_request_upload_url_schema_keeps_required_fields():
    """Regression: the old mock omitted request_upload_url's required
    content_type / size_bytes."""
    st = {t.name: t for t in lc_adapter.to_langchain_tools(ALL_13_TOOLS, _RecordingCallTool())}[
        "request_upload_url"
    ]
    assert set(st.args_schema["required"]) >= {"filename", "content_type", "size_bytes"}


def test_fewer_tools_no_hardcoded_count():
    subset = ALL_13_TOOLS[:3]
    tools = lc_adapter.to_langchain_tools(subset, _RecordingCallTool())
    assert len(tools) == 3


def test_dict_descriptor_supported():
    tools = lc_adapter.to_langchain_tools(
        [{"name": "whoami", "description": "id", "inputSchema": {"type": "object", "properties": {}}}],
        _RecordingCallTool(),
    )
    assert tools[0].name == "whoami"


def test_missing_name_raises():
    with pytest.raises(ValueError, match="missing a 'name'"):
        lc_adapter.to_langchain_tool(
            {"description": "x", "inputSchema": {"type": "object", "properties": {}}},
            _RecordingCallTool(),
        )


# --------------------------------------------------------------------------
# Invocation behaviour
# --------------------------------------------------------------------------

def test_tool_dispatches_to_call_tool():
    dispatcher = _RecordingCallTool(response="hello")
    tools = {t.name: t for t in lc_adapter.to_langchain_tools(ALL_13_TOOLS, dispatcher)}
    out = asyncio.run(tools["get_artifact"].ainvoke({"artifact_id": "art_x"}))
    assert out == "hello"
    assert dispatcher.calls == [("get_artifact", {"artifact_id": "art_x"})]


def test_call_tool_result_text_extracted():
    class _Result:
        isError = False
        content = [type("Block", (), {"text": "line1"})(), type("Block", (), {"text": "line2"})()]
        structuredContent = None

    async def _call(name, args):
        return _Result()

    tool = lc_adapter.to_langchain_tool(ALL_13_TOOLS[0], _call)
    assert asyncio.run(tool.ainvoke({})) == "line1\nline2"


def test_call_tool_error_raises_tool_exception():
    class _ErrResult:
        isError = True
        content = [type("Block", (), {"text": "unauthorized"})()]
        structuredContent = None

    async def _call(name, args):
        return _ErrResult()

    tool = lc_adapter.to_langchain_tool(ALL_13_TOOLS[0], _call)
    with pytest.raises(ToolException, match="unauthorized"):
        asyncio.run(tool.ainvoke({}))


def test_structured_content_fallback_when_no_text():
    class _Result:
        isError = False
        content = []
        structuredContent = {"plan": "free"}

    async def _call(name, args):
        return _Result()

    tool = lc_adapter.to_langchain_tool(ALL_13_TOOLS[0], _call)
    assert asyncio.run(tool.ainvoke({})) == '{"plan": "free"}'


# --------------------------------------------------------------------------
# get_tools offline mode
# --------------------------------------------------------------------------

def test_get_tools_offline_mode():
    dispatcher = _RecordingCallTool()
    tools = lc_adapter.get_tools(mcp_tools=ALL_13_TOOLS, call_tool=dispatcher)
    assert len(tools) == 13


def test_get_tools_offline_requires_call_tool():
    with pytest.raises(ValueError, match="call_tool is required"):
        lc_adapter.get_tools(mcp_tools=ALL_13_TOOLS)


# --------------------------------------------------------------------------
# aget_tools — from a connected (mocked) session
# --------------------------------------------------------------------------

def test_aget_tools_from_mocked_session():
    class _ListResult:
        tools = ALL_13_TOOLS

    class _Session:
        def __init__(self):
            self.called: list[tuple[str, dict]] = []

        async def list_tools(self):
            return _ListResult()

        async def call_tool(self, name, arguments):
            self.called.append((name, arguments))
            return "ok"

    session = _Session()
    tools = asyncio.run(lc_adapter.aget_tools(session))
    assert len(tools) == 13
    # The wrapped tool dispatches back into session.call_tool.
    by_name = {t.name: t for t in tools}
    asyncio.run(by_name["whoami"].ainvoke({}))
    assert session.called == [("whoami", {})]


# --------------------------------------------------------------------------
# Real stdio integration — spawn the actual MCP server subprocess, list tools
# over the wire, and assert the LangChain tools match the LIVE `tools/list`
# payload. No real Artifacta API call: `list_tools` only reads the registry, so
# a fake key lets the server start and list offline. This is the test the
# mocked-catalog suite cannot give — it exercises the real stdio contract.
# --------------------------------------------------------------------------

# Importable but might not have the stdio client surface in odd installs.
pytest.importorskip("mcp")


async def _list_via_real_stdio() -> list[StructuredTool]:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    from artifacta_mcp import build_stdio_params

    # Default command = current interpreter (`-m artifacta_mcp.cli`), so the
    # server is found without the console script on PATH. allow_destructive
    # surfaces all 13 tools (destructive ones are hidden otherwise).
    params_dict = build_stdio_params(
        api_key="ak_live_faketestkey0000000000000000",
        allow_destructive=True,
    )
    params = StdioServerParameters(**params_dict)
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            return await lc_adapter.aget_tools(session)


def test_real_stdio_lists_all_13_tools_and_matches_schemas():
    tools = asyncio.run(asyncio.wait_for(_list_via_real_stdio(), timeout=30))
    by_name = {t.name: t for t in tools}
    assert set(by_name) == EXPECTED_TOOL_NAMES
    # The live server's advertised schemas must match what we wrap — compare a
    # couple of the constraint-bearing ones end-to-end.
    assert by_name["store_artifact"].args_schema["required"] == ["filename"]
    assert "oneOf" in by_name["store_artifact"].args_schema
    assert set(by_name["request_upload_url"].args_schema["required"]) >= {
        "filename", "content_type", "size_bytes",
    }
