"""Artifacta + LangChain — basic adapter example.

Connects to the Artifacta MCP server, wraps its tools as LangChain
``StructuredTool`` instances, and runs a simple discovery flow.

Run:
    pip install 'artifacta-mcp[langchain]'
    export ARTIFACTA_API_KEY=ak_live_...
    python mcp/python/examples/langchain/basic.py

If OPENAI_API_KEY is set and `langchain-openai` is installed, the script also
runs an LLM-driven discovery prompt through a LangChain tool-calling agent.
Otherwise it falls back to invoking the `whoami` tool directly so the example
still runs end-to-end without an LLM provider.
"""
from __future__ import annotations

import asyncio
import os

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from artifacta_mcp import build_stdio_params
from artifacta_mcp.langchain import aget_tools


async def main() -> None:
    if not os.environ.get("ARTIFACTA_API_KEY"):
        raise SystemExit(
            "Set ARTIFACTA_API_KEY (ak_live_...). "
            "Get one at https://app.artifacta.io/dashboard/keys"
        )

    # Launch the artifacta-mcp stdio server and keep the session open while we
    # use the tools (the lifecycle-correct pattern).
    params = StdioServerParameters(**build_stdio_params())
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools = await aget_tools(session)
            print(f"Registered {len(tools)} Artifacta tools with LangChain:")
            for tool in tools:
                print(f"  - {tool.name}: {tool.description.splitlines()[0]}")

            # --- LLM-driven discovery (optional) -----------------------------
            if os.environ.get("OPENAI_API_KEY"):
                try:
                    from langchain.agents import create_tool_calling_agent
                    from langchain_core.prompts import ChatPromptTemplate
                    from langchain_openai import ChatOpenAI
                except ImportError:
                    print(
                        "\n(Install `langchain langchain-openai` to run the "
                        "LLM-driven discovery prompt.)"
                    )
                else:
                    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
                    prompt = ChatPromptTemplate.from_messages(
                        [
                            ("system", "You use Artifacta tools to manage artifacts."),
                            ("human", "{input}"),
                            ("placeholder", "{agent_scratchpad}"),
                        ]
                    )
                    from langchain.agents import AgentExecutor

                    agent = create_tool_calling_agent(llm, tools, prompt)
                    executor = AgentExecutor(agent=agent, tools=tools, verbose=True)
                    result = await executor.ainvoke(
                        {"input": "What is my Artifacta plan and current usage?"}
                    )
                    print("\nAgent answer:\n", result["output"])
                    return

            # --- Fallback: invoke whoami directly ---------------------------
            whoami = next(t for t in tools if t.name == "whoami")
            print("\nNo OPENAI_API_KEY set — calling `whoami` directly:")
            print(await whoami.ainvoke({}))


if __name__ == "__main__":
    asyncio.run(main())
