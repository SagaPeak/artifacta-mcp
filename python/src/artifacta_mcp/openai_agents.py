"""OpenAI Agents SDK integration for the Artifacta MCP server.

Thin convenience layer over the OpenAI Agents SDK's native MCP support
(`agents.mcp.MCPServerStdio`). It does **not** add tools or any
OpenAI-specific behaviour to the MCP server itself (plan §8.2 scope boundary) —
it only saves you from hand-writing the `command` / `args` / `env` that launch
the published `artifacta-mcp` stdio server as a subprocess and registering it
on an `Agent`.

Usage::

    from agents import Agent, Runner
    from artifacta_mcp.openai_agents import artifacta_mcp_server

    async with artifacta_mcp_server(allow_path="/Users/you/out") as artifacta:
        agent = Agent(
            name="report-writer",
            instructions="Produce files and store them in Artifacta.",
            mcp_servers=[artifacta],
        )
        result = await Runner.run(agent, "Write a 5-page report on X and store it.")

Or attach to an already-constructed agent::

    from artifacta_mcp.openai_agents import register

    server = register(agent, allow_path="/Users/you/out")
    await server.connect()   # or use it as an async context manager

The OpenAI Agents SDK is an **optional** dependency. Install the extra::

    pip install 'artifacta-mcp[openai-agents]'

This module imports `agents.mcp` lazily, so importing
`artifacta_mcp.openai_agents` (and calling :func:`build_stdio_params`) works
even when the SDK is not installed — only :func:`artifacta_mcp_server` and
:func:`register` require it.
"""
from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

# Shared, dependency-free launch-parameter builder (also used by
# artifacta_mcp.langchain). Re-exported here for backward compatibility.
from ._integration_common import ARTIFACTA_MCP_COMMAND, build_stdio_params

if TYPE_CHECKING:  # pragma: no cover - typing only
    from agents import Agent
    from agents.mcp import MCPServerStdio

__all__ = [
    "ARTIFACTA_MCP_COMMAND",
    "build_stdio_params",
    "artifacta_mcp_server",
    "register",
]

_INSTALL_HINT = (
    "The OpenAI Agents SDK is not installed. Install the optional extra:\n"
    "    pip install 'artifacta-mcp[openai-agents]'\n"
    "(or `pip install openai-agents`)."
)


def artifacta_mcp_server(
    *,
    api_key: str | None = None,
    api_url: str | None = None,
    allow_path: str | Sequence[str] | None = None,
    allow_destructive: bool = False,
    command: str | None = None,
    args: Sequence[str] | None = None,
    extra_env: dict[str, str] | None = None,
    name: str = "artifacta",
    cache_tools_list: bool = True,
    **server_kwargs: Any,
) -> MCPServerStdio:
    """Construct an `agents.mcp.MCPServerStdio` for the Artifacta MCP server.

    The returned object is an async context manager / has ``connect()`` —
    follow the OpenAI Agents SDK lifecycle (``async with`` or
    ``await server.connect()``). Pass it to ``Agent(mcp_servers=[...])`` or use
    :func:`register`.

    ``cache_tools_list=True`` is the default because the Artifacta tool list is
    stable per launch (it only changes with ``--allow-destructive`` / client
    capability, both fixed at startup), so caching avoids a re-`list_tools`
    round-trip on every agent turn.

    Raises ``ImportError`` with an install hint if the OpenAI Agents SDK is not
    installed.
    """
    try:
        from agents.mcp import MCPServerStdio
    except ImportError as exc:  # pragma: no cover - exercised via monkeypatch test
        raise ImportError(_INSTALL_HINT) from exc

    params = build_stdio_params(
        api_key=api_key,
        api_url=api_url,
        allow_path=allow_path,
        allow_destructive=allow_destructive,
        command=command,
        args=args,
        extra_env=extra_env,
    )
    return MCPServerStdio(
        params=params,
        cache_tools_list=cache_tools_list,
        name=name,
        **server_kwargs,
    )


def register(
    agent: Agent,
    server: MCPServerStdio | None = None,
    **kwargs: Any,
) -> MCPServerStdio:
    """Attach the Artifacta MCP server to ``agent`` and return the server.

    If ``server`` is omitted, one is built from ``**kwargs`` (forwarded to
    :func:`artifacta_mcp_server`). Appends to the agent's ``mcp_servers`` list
    so existing MCP servers on the agent are preserved.

    The OpenAI Agents SDK discovers the tool catalog by calling ``list_tools``
    on each registered MCP server, so no per-tool wiring is needed — but you
    must still open the connection (``await server.connect()`` or use it as an
    async context manager) before running the agent.

    Returns the server so the caller can manage its lifecycle.
    """
    if server is None:
        server = artifacta_mcp_server(**kwargs)
    elif kwargs:
        raise TypeError(
            "Pass either an explicit `server=` or builder kwargs, not both."
        )

    existing = getattr(agent, "mcp_servers", None)
    if existing is None:
        agent.mcp_servers = [server]
    else:
        existing.append(server)
    return server
