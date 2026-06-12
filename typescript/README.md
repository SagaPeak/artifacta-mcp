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

## Troubleshooting

### `unauthorized` errors on every tool call

The most common failure mode is a missing or invalid API key. The MCP server itself starts even when no key is configured — the auth check happens on the first tool call. When that call fails, the server returns a structured remediation block to the agent. Common causes:

- **No key configured at all.** The server has no `--api-key`, no `ARTIFACTA_API_KEY`, and no `~/.artifacta/mcp.toml`. Set one of the three.
- **Wrong env var name.** Must be `ARTIFACTA_API_KEY` exactly. `ARTIFACTA_KEY` and `API_KEY` are not read.
- **Key revoked.** The key was rotated or revoked in the dashboard. Generate a new one at <https://artifacta.io/dashboard/api-keys>.
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
