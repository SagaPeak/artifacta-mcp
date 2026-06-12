"""LangChain / LangGraph adapter for the Artifacta MCP server.

Exposes each Artifacta MCP tool as a LangChain ``StructuredTool`` so it can be
bound to a LangChain agent (or a LangGraph graph — same ``Tool`` interface).
The adapter is a **thin layer over the official MCP Python client**: it reads
the tool catalog the connected MCP server advertises (``tools/list``) and wraps
each entry, mirroring its ``name``, ``description``, and input schema. It adds
no tools of its own and no LangChain-specific behaviour to the server.

LangChain is an **optional** dependency. Install the extra::

    pip install 'artifacta-mcp[langchain]'

Recommended (lifecycle-correct) usage keeps the MCP session open while the
tools are used::

    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    from artifacta_mcp import build_stdio_params
    from artifacta_mcp.langchain import aget_tools

    params = StdioServerParameters(**build_stdio_params(allow_path="/abs/out"))
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await aget_tools(session)   # valid while the session is open
            # ... bind `tools` to your LangChain / LangGraph agent and run ...

Quick start (sync, introspection + one-shot calls)::

    from artifacta_mcp.langchain import get_tools
    tools = get_tools()                      # uses $ARTIFACTA_API_KEY
    print([t.name for t in tools])

``get_tools()`` opens a short-lived MCP session per tool call, so the returned
tools remain callable after the function returns — convenient, but it spawns a
subprocess per call. For repeated calls or production, prefer
:func:`aget_tools` with a long-lived session.
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable, Sequence
from typing import TYPE_CHECKING, Any

from ._integration_common import build_stdio_params

if TYPE_CHECKING:  # pragma: no cover - typing only
    from langchain_core.tools import StructuredTool

__all__ = [
    "to_langchain_tool",
    "to_langchain_tools",
    "aget_tools",
    "get_tools",
]

# A callable that dispatches an MCP tool call: (tool_name, arguments) -> result.
CallTool = Callable[[str, dict[str, Any]], Awaitable[Any]]

_INSTALL_HINT = (
    "LangChain is not installed. Install the optional extra:\n"
    "    pip install 'artifacta-mcp[langchain]'\n"
    "(or `pip install langchain-core`)."
)


def _import_langchain():
    try:
        from langchain_core.tools import StructuredTool, ToolException
    except ImportError as exc:  # pragma: no cover - exercised via monkeypatch test
        raise ImportError(_INSTALL_HINT) from exc
    return StructuredTool, ToolException


def _tool_field(mcp_tool: Any, name: str, default: Any = None) -> Any:
    """Read a field from an MCP Tool (pydantic model) or a plain dict."""
    if isinstance(mcp_tool, dict):
        return mcp_tool.get(name, default)
    return getattr(mcp_tool, name, default)


def _result_to_output(result: Any, tool_exception: type[Exception]) -> str:
    """Reduce an MCP ``CallToolResult`` (or a plain value) to a string.

    Raises ``ToolException`` when the MCP result is flagged ``isError`` so the
    LangChain agent surfaces the failure rather than treating the error text as
    a successful answer. Plain strings (test mocks / trivial dispatchers) pass
    through unchanged.
    """
    if isinstance(result, str):
        return result

    is_error = bool(_tool_field(result, "isError", False))
    content = _tool_field(result, "content", None)
    text_parts: list[str] = []
    if content:
        for block in content:
            text = _tool_field(block, "text", None)
            if text is not None:
                text_parts.append(text)

    if text_parts:
        output = "\n".join(text_parts)
    else:
        structured = _tool_field(result, "structuredContent", None)
        output = json.dumps(structured) if structured is not None else str(result)

    if is_error:
        raise tool_exception(output)
    return output


def to_langchain_tool(mcp_tool: Any, call_tool: CallTool) -> StructuredTool:
    """Wrap a single MCP tool descriptor as a LangChain ``StructuredTool``.

    ``mcp_tool`` is an ``mcp.types.Tool`` (or a dict with ``name`` /
    ``description`` / ``inputSchema``). ``call_tool`` is an async dispatcher
    ``(name, arguments) -> result``. The tool's ``name``, ``description``, and
    ``args_schema`` mirror the MCP descriptor; ``args_schema`` is the MCP JSON
    input schema verbatim (``StructuredTool`` accepts a raw JSON-schema dict).

    The returned tool is **async** (``coroutine`` only) because MCP tool calls
    are async — use ``await tool.ainvoke(...)`` or an async LangChain/LangGraph
    agent.
    """
    structured_tool_cls, tool_exception = _import_langchain()

    name = _tool_field(mcp_tool, "name")
    if not name:
        raise ValueError("MCP tool descriptor is missing a 'name'.")
    description = _tool_field(mcp_tool, "description") or ""
    input_schema = _tool_field(mcp_tool, "inputSchema") or {
        "type": "object",
        "properties": {},
    }

    async def _coroutine(**kwargs: Any) -> str:
        result = await call_tool(name, kwargs)
        return _result_to_output(result, tool_exception)

    return structured_tool_cls(
        name=name,
        description=description,
        args_schema=input_schema,
        coroutine=_coroutine,
    )


def to_langchain_tools(
    mcp_tools: Sequence[Any], call_tool: CallTool
) -> list[StructuredTool]:
    """Wrap every advertised MCP tool. One ``StructuredTool`` per descriptor —
    no hard-coded tool count, so a server advertising fewer tools yields fewer
    LangChain tools."""
    return [to_langchain_tool(t, call_tool) for t in mcp_tools]


async def aget_tools(session: Any) -> list[StructuredTool]:
    """Build LangChain tools from a connected MCP ``ClientSession``.

    The returned tools call back into ``session``, so they are valid only while
    the session context is open. This is the lifecycle-correct entry point for
    agents that make repeated calls.
    """
    listed = await session.list_tools()
    mcp_tools = getattr(listed, "tools", listed)

    async def _call(tool_name: str, arguments: dict[str, Any]) -> Any:
        return await session.call_tool(tool_name, arguments)

    return to_langchain_tools(mcp_tools, _call)


async def _list_mcp_tools(params_dict: dict[str, Any]) -> list[Any]:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    params = StdioServerParameters(**params_dict)
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            listed = await session.list_tools()
            return list(getattr(listed, "tools", listed))


def _stdio_call_tool(params_dict: dict[str, Any]) -> CallTool:
    """A stateless dispatcher: opens a fresh short-lived MCP session per call.

    Lets :func:`get_tools` return tools that remain callable after it returns,
    at the cost of a subprocess per call. Prefer :func:`aget_tools` with a
    long-lived session for repeated calls.
    """

    async def _call(tool_name: str, arguments: dict[str, Any]) -> Any:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        params = StdioServerParameters(**params_dict)
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                return await session.call_tool(tool_name, arguments)

    return _call


def get_tools(
    *,
    mcp_tools: Sequence[Any] | None = None,
    call_tool: CallTool | None = None,
    **server_kwargs: Any,
) -> list[StructuredTool]:
    """Return LangChain tools for the Artifacta MCP server (sync convenience).

    Two modes:

    - **Offline / bring-your-own:** pass ``mcp_tools`` (descriptors) and
      ``call_tool`` (dispatcher) to wrap a known tool set without launching a
      server. Used by tests and callers that already hold a session.
    - **Live (default):** with no ``mcp_tools``, launch the ``artifacta-mcp``
      stdio server (``server_kwargs`` forwarded to
      :func:`~artifacta_mcp.build_stdio_params` —
      ``api_key`` / ``api_url`` / ``allow_path`` / ``allow_destructive`` /
      ``command`` / ``args``), read the advertised catalog, and wrap each tool
      with a stateless per-call dispatcher.

    Must be called from a synchronous context (it uses ``asyncio.run``); inside
    a running event loop, use :func:`aget_tools` instead.
    """
    if mcp_tools is not None:
        if call_tool is None:
            raise ValueError("call_tool is required when mcp_tools is provided.")
        return to_langchain_tools(mcp_tools, call_tool)

    # Validates the API key up front and builds the launch params once.
    params_dict = build_stdio_params(**server_kwargs)
    discovered = asyncio.run(_list_mcp_tools(params_dict))
    return to_langchain_tools(discovered, _stdio_call_tool(params_dict))
