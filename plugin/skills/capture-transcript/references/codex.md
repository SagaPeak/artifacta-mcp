# Codex transcript capture

Use this workflow only in Codex. Codex transcript uploads are MCP-only: always
call `mcp__artifacta__store_artifact` and never use the Artifacta CLI.

Artifacta performs **No redaction**. The snapshot can contain prompts, tool
arguments, tool results, credentials, and other sensitive text. Never display
its raw bytes or base64 in commentary or the final response.

## Resolve the bundled helper

Codex provides the absolute path of the loaded `SKILL.md` in the skill listing.
Resolve the plugin root from that path, then use the deterministic helper:

```bash
SKILL_PATH="<absolute path of the loaded capture-transcript/SKILL.md>"
PLUGIN_ROOT="$(cd "$(dirname "$SKILL_PATH")/../.." && pwd)"
HELPER="$PLUGIN_ROOT/scripts/codex_transcript.py"
test -f "$HELPER"
```

Do not search for or execute a similarly named helper elsewhere.

Before either capture mode, call `mcp__artifacta__whoami` once. If the tool is
unavailable or authentication fails, stop before snapshotting or arming and
tell the user to run `codex mcp login artifacta`. Never request or handle an API
key for this workflow.

## Immediate capture (default)

Use this flow when the request does not contain the explicit `--automatic`
flag.

1. Choose an exact, distinctive phrase from the current conversation. Prefer a
   recent user phrase unlikely to occur in another session.
2. Discover exactly one rollout:

   ```bash
   python3 "$HELPER" discover --phrase "<exact distinctive phrase>"
   ```

   The command searches `${CODEX_HOME:-~/.codex}/sessions/**/*.jsonl`, rejects
   symlinks, and fails unless exactly one regular file matches. If it fails,
   try a more distinctive phrase. If verification remains ambiguous, stop;
   never use the newest file as a substitute.
3. Pass the verified `transcript_path` to:

   ```bash
   python3 "$HELPER" snapshot --transcript "<verified transcript_path>"
   ```

   This creates a private `0600` copy and returns sanitized JSON metadata:
   `session_id`, `snapshot_path`, decoded `size_bytes`, SHA-256,
   `idempotency_key`, and best-effort model fields. It rejects content above
   the hosted MCP 10 MiB decoded-content limit. Do not truncate or split an
   oversize transcript.
4. Base64-encode the private snapshot only to populate the MCP `content`
   argument. Do not paste the base64 into commentary or the final response.
5. Call `mcp__artifacta__store_artifact` with:

   ```json
   {
     "filename": "transcript-<session-id>.jsonl",
     "content": "<base64 snapshot bytes>",
     "content_type": "application/x-ndjson",
     "session_id": "<session-id>",
     "agent_id": "codex",
     "transcript": true,
     "model": "<last observed model, when available>",
     "metadata": {
       "capture": "snapshot",
       "model_source": "transcript",
       "models_used": "<comma-separated distinct observed models>",
       "client": "codex"
     },
     "idempotency_key": "codex-transcript:<session-id>:<sha256>"
   }
   ```

   If no model was observed, omit `model`, `model_source`, and `models_used`
   together. Do not add a `content_encoding` tool argument; the MCP server adds
   the API transport field.
6. After MCP success, delete the private snapshot. On failure, retain it only
   long enough for a deliberate retry with the same `idempotency_key`, then
   remove it.
7. Report the artifact ID, filename, decoded size, and
   `capture=snapshot`. Explain that a mid-turn snapshot may not contain the
   request that triggered capture or this response. For retrieval, use
   `mcp__artifacta__list_artifacts` with the session ID and `transcript=true`.

Never use remote MCP `path`: the hosted server cannot read the caller's local
filesystem. Never substitute an API-key login, local executable, truncation, or
chunking when MCP inline content is too large.

## One-shot automatic capture (`--automatic`)

The explicit `--automatic` flag is consent to upload one unredacted snapshot
from the current session at the next `Stop`. It does not enable future-session
or every-turn capture.

When the user includes the flag:

1. Warn that the snapshot is unredacted and can contain secrets. Continue
   because the explicit flag is current-session consent.
2. Run `discover` exactly as in the immediate flow.
3. Use its verified `session_id` and `transcript_path` to arm the session:

   ```bash
   python3 "$HELPER" arm \
     --session-id "<session-id>" \
     --transcript "<verified transcript_path>"
   ```

4. Report that one capture is armed for the next `Stop`. Do not upload an
   immediate duplicate.

The bundled Stop hook changes the marker from `armed` to `triggered` and asks
Codex for one continuation. It never uploads data or handles credentials.

## Automatic continuation

When a Stop-generated continuation asks to complete an armed capture:

1. Use the session ID from the continuation and read sanitized state:

   ```bash
   python3 "$HELPER" status --session-id "<session-id>"
   ```

2. Require `state=triggered`. Snapshot its recorded transcript path.
3. Call `mcp__artifacta__store_artifact` exactly as in the immediate flow,
   except set `metadata.capture` to `automatic_stop`.
4. Only after MCP success, disarm:

   ```bash
   python3 "$HELPER" complete --session-id "<session-id>"
   ```

5. Delete the private snapshot and report the result.

If upload fails, do not call `complete`. The marker remains `triggered`, which
prevents a Stop loop. Report the failure; the user can explicitly retry with
the same idempotency key or issue another `--automatic` request to re-arm.

Codex also exposes `SessionEnd`, but that event is advisory and cannot keep the
thread open for an authenticated MCP call. Do not replace this next `Stop`
workflow with a `SessionEnd` uploader.
