# Artifacta plugin for Claude Code

The fastest way to give Claude Code access to Artifacta: one marketplace
install wires up the hosted MCP connection and a skill for persisting run
outputs.

## Install

```text
/plugin marketplace add SagaPeak/artifacta-mcp
/plugin install artifacta@artifacta
```

## What it bundles

- **Hosted MCP connection** — `https://mcp.artifacta.io/mcp` over OAuth. No
  API key to copy or store; no local process to run.
- **`persisting-outputs` skill** — auto-triggers when a run produces outputs
  worth keeping (reports, datasets, generated files, analysis results). Also
  invocable directly as `/artifacta:persisting-outputs`.
- **`capture-transcript` skill** — auto-triggers when you ask to save or
  upload the current session's transcript (conversation log). Locates and
  verifies the live transcript, pushes a tagged snapshot, and can offer to
  set up automatic capture at session end (opt-in). Also invocable directly
  as `/artifacta:capture-transcript`.

## Authentication

Run `/mcp` → `artifacta` → **Authenticate**. The consent screen offers three
scopes — `artifacts:read` ⊆ `artifacts:write` ⊆ `artifacts:destroy`. For daily
use, `read` + `write` is enough; grant `destroy` only if you want the agent
able to delete artifacts.

All tools stay visible regardless of granted scope. Calling a tool the token
wasn't granted for returns an `insufficient_scope` error naming the missing
scope — re-authenticate to broaden the grant.

To sign out:

```text
claude mcp logout artifacta
```

## Updating

The plugin has no `version` field — it's versioned by git SHA. Pull the
latest with:

```text
/plugin marketplace update artifacta
```

## Uninstall

```text
/plugin uninstall artifacta@artifacta
```

This removes the plugin, the MCP server, and the skill. The OAuth grant on
Artifacta's side survives the uninstall — revoke it separately at
[app.artifacta.io](https://app.artifacta.io) if you no longer want the
connection authorized.

## Full docs

[docs.artifacta.io/mcp/install/claude-code-plugin](https://docs.artifacta.io/mcp/install/claude-code-plugin)
