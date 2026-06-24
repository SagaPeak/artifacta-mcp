# @artifacta-mcp/mcp

Artifacta MCP server — artifact store for AI agents.

## Installation

```bash
npx @artifacta-mcp/mcp
```

Or install globally:

```bash
npm install -g @artifacta-mcp/mcp
```

## Configuration

The server resolves your Artifacta API key using the following precedence (highest first):

| Source | How to set |
|--------|-----------|
| `--api-key=<key>` flag | Pass at launch: `artifacta-mcp --api-key=ak_live_...` |
| `ARTIFACTA_API_KEY` env var | `export ARTIFACTA_API_KEY=ak_live_...` |
| `~/.artifacta/mcp.toml` | See config file format below |
| *(none)* | Server starts; first tool call returns an auth error with setup instructions |

The API base URL follows the same precedence via `--api-url`, `ARTIFACTA_API_URL`, or `api_url` in the config file. Defaults to `https://api.artifacta.io`.

### Config file format

```toml
[default]
api_key = "ak_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
api_url = "https://api.artifacta.io"   # optional

[staging]
api_key = "ak_live_yyyy..."
api_url = "https://api.staging.artifacta.io"
```

Select a profile with `--profile=staging` or `ARTIFACTA_PROFILE=staging`.

Profile precedence: `--profile` flag > `ARTIFACTA_PROFILE` env > `[default]` section.

When both `--api-key` and `--profile` are passed, `--api-key` wins for the credential but `--profile` still selects `api_url` from the named section (unless `--api-url` is also passed).

### File permissions (Linux/macOS)

The config file must not be world-writable. The server refuses to start if `~/.artifacta/mcp.toml` has write permission for others (`chmod 600 ~/.artifacta/mcp.toml` is recommended). A warning is emitted if the file is world-readable.

### File permissions (Windows) — known limitation

POSIX file permission enforcement is not available on Windows in v1. The server emits a one-time warning when loading `~/.artifacta/mcp.toml` and continues without checking ACLs. Ensure the file is restricted to your own user account via Windows file properties or `icacls`.

**Deviation from POSIX behavior:** On Windows, world-writable and world-readable permission checks are skipped entirely. This will be addressed in a future release when Windows ACL probing is implemented.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Clean exit (--version, --help, graceful shutdown) |
| 1 | Runtime or transport failure |
| 2 | Configuration or permissions error (invalid key, world-writable file, missing profile) |

## Usage with Claude Desktop and Cursor

Full client setup — launch flags, path confinement, share-link consent, and
troubleshooting — is documented in the [MCP server
overview](https://docs.artifacta.io/mcp/overview).

Claude Desktop and Cursor do not advertise MCP write confirmations. Add
`--allow-destructive` so `create_download_link` (public share URLs) appears
in `tools/list`; without it the tool is hidden by design. Combine with
`--allow-path` when using `store_artifact.path` for local file uploads.

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows). Cursor uses `~/.cursor/mcp.json` (or project-local `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "artifacta": {
      "command": "npx",
      "args": ["-y", "@artifacta-mcp/mcp", "--allow-path", "/Users/you/uploads", "--allow-destructive"],
      "env": {
        "ARTIFACTA_API_KEY": "ak_live_..."
      }
    }
  }
}
```

The `-y` flag tells `npx` to skip the install confirmation prompt — required for unattended startup. Omit `--allow-path` if you only need inline `content` uploads and read-only tools.

After saving, restart the host and confirm the server is connected from the MCP settings panel.

## Hosted MCP (Streamable HTTP)

A hosted endpoint is available at **`https://mcp.artifacta.io/mcp`** so agents can
use Artifacta without installing this package or running a local process. The
hosted server is the same TypeScript server, run with `--transport=http`. The
npm and PyPI stdio packages remain fully supported and are unchanged; the Python
package is **stdio-only** and does not serve HTTP.

### Connect with OAuth (standard interactive path)

For interactive clients (Claude Code, Claude Desktop, Cursor), connect by URL and
sign in through your browser — no API key to copy. The one-liner
`claude mcp add --transport http artifacta https://mcp.artifacta.io/mcp` self-registers
a public OAuth client via Dynamic Client Registration (PKCE, **no client secret**);
a fixed-`clientId` `add-json` form is the manual fallback. You choose the tool
permissions (read / write / destroy) on a consent screen. Full setup, including
both forms and the `/mcp` → Authenticate flow, is documented here:

**[Connect Claude Code (Hosted)](https://docs.artifacta.io/mcp/install/claude-code-hosted)**

### Headless / CI — `ak_live_` bearer

For unattended agents and CI that cannot run an interactive browser login, the
hosted endpoint also accepts a raw `ak_live_` API key as a bearer token,
forwarded to the REST API exactly as stdio does. API keys are full-access, so all
tools are exposed. This is the **headless / CI-only** path — interactive users
should use OAuth above.

### Endpoint contract

| Request | Result |
|---------|--------|
| `POST /mcp` | JSON-RPC, returns `application/json` (stateless — no `MCP-Session-Id`) |
| `GET /mcp` | `405 Method Not Allowed` (no long-lived SSE in v1) |
| `GET /healthz` | `200 {"status":"ok"}` |

Send `Authorization: Bearer <your ak_live_ key>` on every `POST /mcp`. Missing or
malformed bearer tokens return `401`. Responses carry `Cache-Control: no-store`.

### curl smoke test (headless `ak_live_` path)

These are the exact calls the deployment canary runs green over the headless
`ak_live_` path. Read the key from the environment — never paste it on the
command line.

```bash
export ARTIFACTA_API_KEY=ak_live_...

# 1. initialize → serverInfo.name == "artifacta"
curl -s https://mcp.artifacta.io/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $ARTIFACTA_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# 2. tools/list → array including whoami, list_artifacts
curl -s https://mcp.artifacta.io/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $ARTIFACTA_API_KEY" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# 3. tools/call whoami → identity, plan, usage
curl -s https://mcp.artifacta.io/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $ARTIFACTA_API_KEY" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
```

The `Accept: application/json, text/event-stream` header is what a compliant MCP
client sends; the SDK requires both media types even though the hosted server
always responds with `application/json`.

### Self-hosting the HTTP transport

To run the HTTP transport yourself (the hosted deployment uses the bundled
`Dockerfile`):

```bash
artifacta-mcp --transport=http --port=8080
```

| Setting | How to set | Notes |
|---------|-----------|-------|
| Transport | `--transport=http` | Default is `stdio`; HTTP is opt-in |
| Port | `--port=<n>` or `PORT` env | `PORT` is used by the Docker image / Railway |
| API base URL | `ARTIFACTA_API_URL` | Defaults to `https://api.artifacta.io` |
| Allowed browser origins | `MCP_ALLOWED_ORIGINS` | Comma-separated exact-match allow-list; a present `Origin` not on the list returns `403`. Absent `Origin` (curl, CI, agents) is allowed. Leave unset for non-browser clients |

Unlike stdio, the HTTP transport does **not** read `ARTIFACTA_API_KEY` from its
environment — each request supplies its own bearer token, so one server can
serve many tenants.

## Troubleshooting

### `unauthorized` errors on every tool call

The most common failure mode is a missing or invalid API key. The MCP server itself starts even when no key is configured — the auth check happens on the first tool call. When that call fails, the server returns a structured remediation block to the agent. Common causes:

- **No key configured at all.** The server has no `--api-key`, no `ARTIFACTA_API_KEY`, and no `~/.artifacta/mcp.toml`. Set one of the three.
- **Wrong env var name.** Must be `ARTIFACTA_API_KEY` exactly. `ARTIFACTA_KEY` and `API_KEY` are not read.
- **Key revoked.** The key was rotated or revoked in the dashboard. Generate a new one at <https://app.artifacta.io/dashboard/keys>.
- **Key shape mismatch.** Keys must match `ak_live_` followed by 32 alphanumeric characters. The server refuses to start (exit 2) if the configured key has the wrong shape.
- **Tenant suspended.** The account is in the post-deletion grace period. The error message includes "suspended"; restore the account from the dashboard.

To verify your key directly:

```bash
curl -H "Authorization: Bearer $ARTIFACTA_API_KEY" https://api.artifacta.io/v1/whoami
```

### Server fails to start on Windows

Windows skips POSIX permission checks on `~/.artifacta/mcp.toml` (see "File permissions (Windows)" above). If startup still fails, check that the file is reachable from the user account Claude Desktop runs as.

### `npx` hangs on first launch

`npx` downloads the package on first run, which can take 10–30 seconds on a slow connection. Subsequent launches use the cache and are near-instant. If `npx` fails with a network error, the package can be installed globally instead: `npm install -g @artifacta-mcp/mcp`, then point Claude Desktop's `command` at `artifacta-mcp` directly with `args: []`.

## License

MIT — see [LICENSE](./LICENSE).
