"""MCP stdio server bootstrap.

Wires the safety registry into the official `mcp` Python SDK's decorator-based
Server. The two gating decisions live here:

1. `list_tools()` calls `safety.get_filtered_tools(...)` with the resolved
   compliance/flag context. Non-compliant clients without `--allow-destructive`
   never see destructive tools.

2. `call_tool()` calls `safety.is_call_permitted(...)` at dispatch — even if a
   non-compliant client somehow learned the tool name, the call is blocked.
   Destructive calls always emit the §5 audit line to stderr.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

import mcp.types as types
from mcp.server import Server
from mcp.server.stdio import stdio_server

from . import __version__
from .safety import (
    FilterOpts,
    ToolCallContext,
    all_registrations,
    emit_destructive_audit,
    get_filtered_tools,
    get_tool_registration,
    is_call_permitted,
)

log = logging.getLogger("artifacta-mcp")


def build_server(allow_destructive: bool, write_confirm_required: bool) -> Server:
    """Create and wire the MCP Server. Caller is responsible for `await server.run(...)`."""
    server: Server = Server(name="artifacta-mcp", version=__version__)

    def _has_confirmations() -> bool:
        """True iff the connected client advertised `experimental.confirmations`."""
        try:
            session = server.request_context.session
        except LookupError:
            return False
        params = getattr(session, "client_params", None)
        if params is None:
            return False
        exp = getattr(params.capabilities, "experimental", None) or {}
        return isinstance(exp, dict) and "confirmations" in exp

    def _client_name() -> str | None:
        """The connected client's `clientInfo.name` from `initialize`, if any."""
        try:
            session = server.request_context.session
        except LookupError:
            return None
        params = getattr(session, "client_params", None)
        if params is None:
            return None
        client_info = getattr(params, "clientInfo", None)
        return getattr(client_info, "name", None)

    @server.list_tools()
    async def _list_tools() -> list[types.Tool]:
        opts = FilterOpts(
            has_confirmations=_has_confirmations(),
            allow_destructive=allow_destructive,
            write_confirm_required=write_confirm_required,
        )
        tools: list[types.Tool] = []
        for t in get_filtered_tools(opts):
            tools.append(
                types.Tool(
                    name=t["name"],
                    description=t["description"],
                    inputSchema=t["inputSchema"],
                    annotations=t.get("annotations"),
                    _meta=t.get("_meta"),
                )
            )
        return tools

    @server.call_tool()
    async def _call_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        reg = get_tool_registration(name)
        if reg is None:
            return {
                "isError": True,
                "content": [
                    {"type": "text", "text": f"Bad arguments: unknown tool '{name}'."}
                ],
                "_meta": {"code": "invalid_request", "status": 400, "retry_hint": "do_not_retry"},
            }

        if not is_call_permitted(reg, _has_confirmations(), allow_destructive):
            # Same payload as the unknown-tool branch above so a gated tool is
            # indistinguishable from an absent one (matches the TS port, which
            # throws MethodNotFound here). Naming the gate would tell a probing
            # client the tool exists and how to get it exposed.
            return {
                "isError": True,
                "content": [
                    {"type": "text", "text": f"Bad arguments: unknown tool '{name}'."}
                ],
                "_meta": {"code": "invalid_request", "status": 400, "retry_hint": "do_not_retry"},
            }

        # Destructive audit emission — fires whenever a destructive tool is called.
        if reg.safety == "destructive":
            emit_destructive_audit(name, arguments)

        ctx = ToolCallContext(request_id=str(uuid.uuid4()), client_name=_client_name())
        try:
            result = await reg.handler(arguments, ctx)
        except Exception as exc:  # pragma: no cover — handler must catch its own errors
            log.exception("tool %s crashed", name)
            return {
                "isError": True,
                "content": [{"type": "text", "text": f"Internal error in {name}: {exc}"}],
                "_meta": {"code": "server_error", "status": 500, "retry_hint": "retry_with_backoff"},
            }

        # Always surface the request_id in _meta for log correlation.
        result.setdefault("_meta", {})["request_id"] = ctx.request_id
        return result

    return server


async def serve_stdio(allow_destructive: bool, write_confirm_required: bool) -> None:
    """Run the MCP server over stdio until the client disconnects."""
    server = build_server(allow_destructive, write_confirm_required)
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )


# Re-export the count of registered tools for tests that need a sanity check.
def registered_tool_names() -> list[str]:
    return [r.name for r in all_registrations()]
