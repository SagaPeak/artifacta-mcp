# Artifacta plugin for Claude Code and Codex

One plugin wires up Artifacta's hosted OAuth MCP connection and reusable skills
for persisting run outputs and capturing supported conversation logs.

## Install in Claude Code

```text
/plugin marketplace add SagaPeak/artifacta-mcp
/plugin install artifacta@artifacta
```

## Install in Codex

Add the marketplace:

```text
codex plugin marketplace add SagaPeak/artifacta-mcp
```

Start Codex, open `/plugins`, select the Artifacta marketplace, and install the
Artifacta plugin. Then authenticate the bundled MCP server:

```text
codex mcp login artifacta
```

Start a new thread so Codex loads the plugin's skills and hooks. Review and
trust the bundled one-shot hook through `/hooks`; Codex skips non-managed
plugin hooks until their current definition is trusted.

## What it bundles

- **Hosted MCP connection** — `https://mcp.artifacta.io/mcp` over OAuth. No
  API key to copy or store; no local process to run.
- **`persisting-outputs` skill** — auto-triggers when a run produces outputs
  worth keeping (reports, datasets, generated files, analysis results). Also
  invocable directly as `/artifacta:persisting-outputs`.
- **`capture-transcript` skill** — auto-triggers when you ask to save or
  upload the current session's transcript (conversation log). Locates and
  verifies the live transcript, then stores a tagged snapshot. In Codex,
  `--automatic` arms one capture for the current session's next `Stop`; it
  does not enable ongoing or future-session capture.

Transcript snapshots are uploaded without redaction and can contain secrets.
Codex transcript capture uses the hosted Artifacta MCP tool, never a local
Artifacta CLI or API key.

## Authentication

Run `/mcp` → `artifacta` → **Authenticate**. The consent screen offers three
scopes — `artifacts:read` ⊆ `artifacts:write` ⊆ `artifacts:destroy`. For daily
use, `read` + `write` is enough; grant `destroy` only if you want the agent
able to mint public share links, delete artifacts, or irreversibly seal
sessions.

All tools stay visible regardless of granted scope. Calling a tool the token
wasn't granted for returns an `insufficient_scope` error naming the missing
scope — re-authenticate to broaden the grant.

To sign out in Claude Code:

```text
claude mcp logout artifacta
```

In Codex, use `codex mcp logout artifacta`.

## Updating

In Claude Code, pull the latest with:

```text
/plugin marketplace update artifacta
```

For a local Codex marketplace update, refresh the marketplace, reinstall the
plugin, and start a new thread so the new cached version is loaded.

For the GitHub marketplace:

```text
codex plugin marketplace upgrade artifacta
```

## Uninstall

```text
/plugin uninstall artifacta@artifacta
```

Uninstall from the same client that installed the plugin. This removes the
plugin, the MCP server, and the skills. The OAuth grant on
Artifacta's side survives the uninstall — revoke it separately at
[app.artifacta.io](https://app.artifacta.io) if you no longer want the
connection authorized.

In Codex, open `/plugins`, select Artifacta, and choose uninstall.

## Full docs

[docs.artifacta.io/mcp/install/claude-code-plugin](https://docs.artifacta.io/mcp/install/claude-code-plugin)
