# artifacta-mcp

mcp-name: io.artifacta/mcp

Artifacta MCP server (Python) — the artifact store for AI agents, exposed
via the Model Context Protocol.

This is the Python port of [`@artifacta-mcp/mcp`](https://github.com/SagaPeak/artifacta-mcp/tree/main/typescript). Same tool
surface, same path-confinement engine, same error contract. Reuses the
[`artifacta`](https://pypi.org/project/artifacta-cli/) SDK as the single
HTTP client — no parallel client implementation.

## Installation

Recommended (no global install):

```bash
pipx run artifacta-mcp
```

Or install into a virtualenv:

```bash
python -m venv .venv && source .venv/bin/activate
pip install artifacta-mcp
artifacta-mcp --version
```

Python 3.10+ required.

## Configuration

| Source | How to set |
|--------|-----------|
| `ARTIFACTA_API_KEY` env var | `export ARTIFACTA_API_KEY=ak_live_...` (required) |
| `ARTIFACTA_API_URL` env var | Override API base (default: `https://api.artifacta.io`) |
| `--allow-path=PATH` | Add `PATH` (absolute) to the path-confinement allow-list. May be passed multiple times. |
| `ARTIFACTA_MCP_ALLOW_PATH` | Colon-separated additional allow-list paths. |
| `--allow-destructive` | Expose destructive tools (`delete_artifact`, `seal_session`, `create_download_link`) to clients that do **not** advertise `experimental.confirmations`. Compliant clients always get them with `requiresConfirmation` set. |
| `ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM=1` | For compliant clients, also require confirmation for `store_artifact`, `request_upload_url`, `complete_upload`, and `create_download_link`. |

Obtain an API key at [https://app.artifacta.io/dashboard/keys](https://app.artifacta.io/dashboard/keys).

## Register with Claude Desktop

Add this block to `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or the equivalent on your platform:

```json
{
  "mcpServers": {
    "artifacta": {
      "command": "pipx",
      "args": ["run", "artifacta-mcp"],
      "env": {
        "ARTIFACTA_API_KEY": "ak_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

Restart Claude Desktop. The `whoami` tool is the fastest way to confirm
authentication.

## Register with Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "artifacta": {
      "command": "pipx",
      "args": ["run", "artifacta-mcp"],
      "env": {
        "ARTIFACTA_API_KEY": "ak_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

## Use with the OpenAI Agents SDK

The `artifacta_mcp.openai_agents` wrapper registers this MCP server as a tool
catalog on an OpenAI Agents SDK `Agent` — no HTTP plumbing, just the MCP tools.
Install the optional extra:

```bash
pip install 'artifacta-mcp[openai-agents]'
```

Construct the server and pass it to your agent (it runs the `artifacta-mcp`
stdio server as a subprocess for the life of the `async with` block):

```python
from agents import Agent, Runner
from artifacta_mcp.openai_agents import artifacta_mcp_server

async with artifacta_mcp_server(allow_path="/Users/you/out") as artifacta:
    agent = Agent(
        name="report-writer",
        instructions="Produce files and store them in Artifacta.",
        mcp_servers=[artifacta],
    )
    result = await Runner.run(agent, "Write a 5-page report on X and store it.")
    print(result.final_output)
```

Or attach to an agent you already built: `register(agent, allow_path=...)`.
Pass `allow_destructive=True` to expose `create_download_link` / `delete_artifact`
/ `seal_session` (human-in-the-loop only).

**Launch + environment contract** (applies to both integrations, via
`build_stdio_params`):

- **Launch command:** by default the server is started with the current
  interpreter (`sys.executable -m artifacta_mcp.cli`), so it works even when the
  `artifacta-mcp` console script is not on `PATH` (notebooks, IDE kernels).
  Override with `command=` / `args=` for pipx or a custom launcher (e.g.
  `command="pipx", args=["run", "artifacta-mcp"]`).
- **Minimal subprocess env:** the child does **not** inherit the full parent
  environment. Only `ARTIFACTA_API_KEY` / `ARTIFACTA_API_URL` (resolved from the
  `api_key=` / `api_url=` arguments or their env vars) plus a small allow-list of
  process/system vars (`PATH`, `HOME`, locale, temp dir, `PYTHONPATH`, Windows
  essentials) cross over. Unrelated secrets (e.g. `OPENAI_API_KEY`) and ambient
  Artifacta knobs are not forwarded.
- **Path allow-list:** widen it only through `allow_path=` (→ `--allow-path`).
  The ambient `ARTIFACTA_MCP_ALLOW_PATH` env var is intentionally not passed to
  the subprocess. To set any other server env var (e.g.
  `ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM`), pass it deliberately via `extra_env=`.

**Starter notebook:** [`examples/openai_agents/starter.ipynb`](examples/openai_agents/starter.ipynb)
walks through an "agent that produces files" demo end-to-end — it prompts the
agent to write and store a report, then asserts the artifact was created.

## Use with LangChain / LangGraph

The `artifacta_mcp.langchain` adapter wraps each Artifacta MCP tool as a
LangChain `StructuredTool` (which LangGraph consumes through the same `Tool`
interface). It mirrors each tool's `name`, `description`, and input schema —
no hard-coded tool list, so it always reflects what the connected server
advertises. Install the optional extra:

```bash
pip install 'artifacta-mcp[langchain]'
```

Supported versions: `langchain-core >=0.3,<1.0` (the adapter needs only
`langchain-core`, not the full `langchain` meta-package).

The lifecycle-correct pattern keeps the MCP session open while the tools are
used:

```python
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from artifacta_mcp import build_stdio_params
from artifacta_mcp.langchain import aget_tools

params = StdioServerParameters(**build_stdio_params(allow_path="/abs/out"))
async with stdio_client(params) as (read, write):
    async with ClientSession(read, write) as session:
        await session.initialize()
        tools = await aget_tools(session)   # bind these to your agent / graph
```

For a quick start, `get_tools()` (sync) launches the server, lists the tools,
and returns them ready to call — see the
[example script](examples/langchain/basic.py), which registers the tools with a
LangChain agent and runs a discovery prompt.

The wrapped tools are **async** (`await tool.ainvoke(...)`), because MCP tool
calls are async — use them with an async LangChain/LangGraph agent.

## Use with CrewAI

CrewAI multi-agent crews can register Artifacta as a tool source via
`crewai-tools`' `MCPServerAdapter`, so a producer agent stores an artifact and a
downstream agent retrieves it. This is a **recipe** (not a packaged adapter):

➡️ **[CrewAI recipe — docs.artifacta.io/mcp/integrations/crewai](https://docs.artifacta.io/mcp/integrations/crewai)**

It covers install, registering the server as a tool source, and a two-agent
crew that hands a stored artifact from one agent to the next.

## Tool surface

Same eleven tools as the TypeScript package (plan §2):

| Tool | Safety | Notes |
|------|--------|-------|
| `whoami` | safe | Identity + plan + quota |
| `list_artifacts` | safe | Pagination via opaque `cursor`; metadata filter requires Pro for multi-key |
| `get_artifact` | safe | Metadata only — no bytes |
| `get_artifact_download_url` | safe | Presigned R2 URL, 1-hour expiry |
| `list_sessions` | safe | Sessions synthesized from artifacts |
| `store_artifact` | writeIdempotent | Inline `content` ≤10 MB OR local `path` ≤500 MB |
| `request_upload_url` | writeNonIdempotent | Pro only; 5xx is ambiguous — read §6.1 guidance |
| `complete_upload` | writeIdempotent | Finalizes a `request_upload_url` artifact |
| `create_download_link` | destructive | Public URL — gated behind `--allow-destructive` for non-compliant clients |
| `delete_artifact` | destructive | Soft-delete; hard-delete after 30 days |
| `seal_session` | destructive | **Irreversible** — no `unseal` endpoint |

The destructive-tool gating engine (`safety/registry`) hides destructive
tools from clients that do not advertise `experimental.confirmations` in
`initialize`, unless `--allow-destructive` is passed at launch. When that
flag exposes a destructive tool, each call emits a `[artifacta-mcp]
destructive call: <tool>(<args>)` audit line to stderr with secret
redaction and 200-char truncation.

## Path confinement

`store_artifact` with the `path` argument validates the path against:

- An **allow-list** of absolute roots (CWD by default; widen with
  `--allow-path=/abs/dir` or `ARTIFACTA_MCP_ALLOW_PATH=/a:/b`).
- A built-in **deny-list** that always wins: `~/.ssh`, `~/.aws`, `~/.gnupg`,
  `~/.config/gh`, `~/.kube`, `~/.artifacta`, `~/.netrc`, `~/Library/Keychains`,
  `/etc`, `/private/etc`, `/var/lib`, `/proc`, `/sys`, `/dev`.
- Filename pattern denies: `credentials.json`, `.env*`.
- A **500 MB** size ceiling.
- Symlink resolution **before** the allow/deny check (so a symlink under your
  CWD that points into `/etc/passwd` is denied as `/etc/passwd`, not allowed
  by allow-list membership of the link site).

The Python engine is cross-validated against the TypeScript engine via the
shared fixture at `mcp/shared/path-confinement-fixture.json`. Identical
accept/reject is a tested contract.

## Troubleshooting

### "Authentication failed" on the first call

The error message includes structured remediation:
1. Confirm `ARTIFACTA_API_KEY` is set in the MCP server's environment
   (the host process — Claude Desktop, Cursor — must pass it through).
2. Verify the key at <https://app.artifacta.io/dashboard/keys>.
3. The error message includes the last 4 chars of the cached key
   (`****<last4>`) when known, so you can confirm which key was used.

### `delete_artifact` / `seal_session` / `create_download_link` not visible

By design — these are destructive and hidden from clients that do not
advertise `experimental.confirmations`. Either:

- Use a client that advertises the capability (it gets the tool with
  `requiresConfirmation: true`), or
- Pass `--allow-destructive` at launch (you give up the consent surface and
  accept the per-call stderr audit line as your only signal).

### `invalid_request: Path '…' is outside the MCP server's allow-list`

Path confinement refused the upload. Widen with `--allow-path=/abs/dir` or
send bytes inline via the `content` field. If the path resolved to
`/etc`, `~/.ssh`, `.env`, or similar — that's the deny-list firing and is
**not** overridable.

### `request_upload_url` failed with "Artifacta API failed mid-write"

`request_upload_url` is non-idempotent (the API does not honor
`Idempotency-Key` here). On 5xx or network error the reservation may have
been created. Per plan §6.1: call `list_artifacts` with the same
`session_id`/`agent_id` before retrying to avoid duplicate artifacts.

## Versioning

The Python package shares the **major.minor** version with the TypeScript
package (`@artifacta-mcp/mcp`). Patch versions are independent. See the
[CHANGELOG](https://github.com/SagaPeak/artifacta-mcp/blob/main/typescript/CHANGELOG.md) for the canonical release notes.

## Development

```bash
cd mcp/python
python -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]'
pytest
ruff check src tests
python -m build
```

## License

MIT — see [LICENSE](LICENSE).
