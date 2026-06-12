# Artifacta MCP Server

[![npm](https://img.shields.io/npm/v/%40artifacta-mcp%2Fmcp)](https://www.npmjs.com/package/@artifacta-mcp/mcp)
[![PyPI](https://img.shields.io/pypi/v/artifacta-mcp)](https://pypi.org/project/artifacta-mcp/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Official MCP server for [Artifacta](https://artifacta.io) — an artifact store
purpose-built for AI agents. Agents persist run outputs (files, reports,
datasets, build results) with session and agent metadata, hand them off across
sessions, and share them via expiring download links. Content-hash dedup means
re-storing the same bytes is free.

Listed in the [official MCP registry](https://registry.modelcontextprotocol.io)
as `io.artifacta/mcp`.

Two implementations with the same tool surface, error contract, and
path-confinement engine:

| Directory | Package | Runtime |
|-----------|---------|---------|
| [`typescript/`](./typescript) | [`@artifacta-mcp/mcp`](https://www.npmjs.com/package/@artifacta-mcp/mcp) | Node 20+ |
| [`python/`](./python) | [`artifacta-mcp`](https://pypi.org/project/artifacta-mcp/) | Python 3.10+ |

## Quick start

Get an API key at [app.artifacta.io/dashboard/keys](https://app.artifacta.io/dashboard/keys),
then add to your MCP client config (Claude Desktop, Claude Code, Cursor, or any
MCP client):

```json
{
  "mcpServers": {
    "artifacta": {
      "command": "npx",
      "args": ["-y", "@artifacta-mcp/mcp"],
      "env": {
        "ARTIFACTA_API_KEY": "ak_live_..."
      }
    }
  }
}
```

Or run the Python implementation with `pipx run artifacta-mcp`.

See the per-package READMEs for config-file profiles, path confinement
(`--allow-path`), destructive-tool gating (`--allow-destructive`), and
troubleshooting: [TypeScript](./typescript/README.md) ·
[Python](./python/README.md).

## Tools

| Tool | Description |
|------|-------------|
| `whoami` | Verify credentials; returns tenant and plan info |
| `store_artifact` | Upload an artifact from inline content or a local path |
| `request_upload_url` / `complete_upload` | Two-phase presigned upload for large files |
| `get_artifact` | Fetch artifact metadata by ID |
| `get_artifact_download_url` | Get a presigned download URL (1h expiry) |
| `list_artifacts` | List/filter artifacts by session, agent, or metadata |
| `list_sessions` | List active sessions |
| `seal_session` | Seal a session so no further artifacts can be added |
| `create_download_link` | Create a public expiring share link (gated behind `--allow-destructive`) |
| `delete_artifact` | Soft-delete an artifact (gated behind write confirmation) |

Plus MCP resources for `whoami`, artifact metadata, artifact bytes, and
sessions.

Safety defaults: local-file uploads are confined to an explicit `--allow-path`
allow-list, and destructive tools (public share links, deletes, session seals)
are hidden from clients that can't confirm writes unless `--allow-destructive`
is passed.

## Framework integrations

The Python package ships optional adapters for
[OpenAI Agents SDK](./python/examples/openai_agents) (`pip install
'artifacta-mcp[openai-agents]'`) and
[LangChain/LangGraph](./python/examples/langchain) (`pip install
'artifacta-mcp[langchain]'`).

## Documentation

Full docs at [docs.artifacta.io/mcp/overview](https://docs.artifacta.io/mcp/overview).

## Development

```bash
# TypeScript
cd typescript && npm install && npm test

# Python
cd python && python -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]' && pytest
```

This repository is published from the Artifacta monorepo; issues and PRs are
welcome here.

## License

MIT — see [LICENSE](./LICENSE).
