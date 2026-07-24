---
name: capture-transcript
description: Use when the user asks to save, upload, capture, or persist this session's transcript (conversation log) to Artifacta, or asks to keep a record of the current Claude Code session. Locates the live session transcript, snapshots it safely, and pushes it as a tagged transcript artifact; can set up automatic capture for future sessions.
---

# Claude Code provider reference

# Capturing a Claude Code session transcript

This skill captures the **current Claude Code session's transcript** and
stores it in Artifacta as a tagged transcript artifact. For persisting
ordinary run outputs (reports, datasets, generated files), use the
`persisting-outputs` skill instead — this one is only for the conversation
log itself.

Follow the steps in order. Each one guards against a specific failure mode.

## 1. Discover the transcript file — verify, never guess

Claude Code writes the live transcript to:

```
~/.claude/projects/<munged-cwd>/<session-uuid>.jsonl
```

`<munged-cwd>` is the session's working directory with path separators and
other special characters (including `.` and `_`) replaced by `-`. For
example, `/Users/jn/Documents/Project/Artifacta_v1` becomes
`-Users-jn-Documents-Project-Artifacta-v1`.

Find candidates by listing `.jsonl` files in that directory sorted by
modification time, newest first:

```bash
ls -t ~/.claude/projects/<munged-cwd>/*.jsonl | head -5
```

**Newest-file alone is not identification.** Two sessions in the same repo
at once is common, and the newest file may belong to the other one. Confirm
the candidate by grepping it for distinctive text that only this
conversation contains — for example, an exact phrase from the user's most
recent message:

```bash
grep -l -F "<distinctive phrase from this conversation>" ~/.claude/projects/<munged-cwd>/*.jsonl
```

If exactly one file matches, that's the transcript, and its basename (minus
`.jsonl`) is the session UUID. If zero or multiple files match, try a more
distinctive phrase. If verification still fails on every candidate, **tell
the user and stop — never push an unverified file.**

The transcript location and format are Anthropic's contract, not
Artifacta's. If the directory or file isn't where this skill says, re-check
Anthropic's current Claude Code documentation rather than guessing.

## 2. Snapshot before pushing

The transcript is being actively appended while the session runs. Never
push the live file — copy it first, push the copy, then delete the copy:

```bash
cp ~/.claude/projects/<munged-cwd>/<session-uuid>.jsonl /tmp/transcript-<session-uuid>.jsonl
```

## 3. Push the snapshot

**Preferred path — the `artifacta` CLI**, when it's installed and
authenticated (`artifacta whoami` succeeds):

```bash
# Capture the model from the snapshot itself (best-effort): last MAIN-LOOP
# assistant model; sidechain/subagent entries and "<synthetic>" are excluded.
MODEL="$(jq -r 'select(.type == "assistant" and .isSidechain != true) | .message.model // empty | select(. != "<synthetic>")' /tmp/transcript-<session-uuid>.jsonl 2>/dev/null | tail -n 1 || true)"
MODELS_USED="$(jq -r 'select(.type == "assistant") | .message.model // empty | select(. != "<synthetic>")' /tmp/transcript-<session-uuid>.jsonl 2>/dev/null | sort -u | paste -sd, - || true)"

MODEL_FLAGS=()
if [[ -n "$MODEL" ]]; then
  MODEL_FLAGS=(--meta "model=$MODEL" --meta "model_source=transcript" --meta "models_used=$MODELS_USED")
fi
artifacta push /tmp/transcript-<session-uuid>.jsonl --transcript --session <session-uuid> --meta capture=snapshot "${MODEL_FLAGS[@]}"
```

The guard is built in: if `MODEL` comes back empty (no main-loop assistant
turns yet), the push omits all three model `--meta` flags.

`--transcript` tags the artifact `metadata.type=transcript` and defaults the
content type to `application/x-ndjson`. Delete the temp copy after the push
succeeds.

**Fallback — MCP `store_artifact`**, for hosted-MCP-only setups without the
CLI. Read the snapshot file and send its bytes as base64 `content` (never
`path` — the hosted server can't see this machine's filesystem):

```json
{
  "filename": "transcript-<session-uuid>.jsonl",
  "content": "<base64 of the snapshot>",
  "session_id": "<session-uuid>",
  "transcript": true,
  "metadata": { "capture": "snapshot", "model": "<last main-loop assistant model>", "model_source": "transcript", "models_used": "<comma-separated distinct models>" }
}
```

Compute the values with the same jq filters as the CLI path before building
the call; omit all three keys if no model is found.

The `content` field caps at 10 MB decoded, and base64 inflates size by
about a third — long sessions can exceed it. If the snapshot is too large,
don't truncate or split it: tell the user the MCP path can't carry it and
that the CLI path handles large files — `pip install artifacta`, then
authenticate with an API key created in the Artifacta dashboard
(`artifacta auth login --key ak_live_...`).

## 4. What a snapshot means — say this when reporting

A mid-session capture cannot contain turns that happen after it — including
the very request that triggered this capture. `capture=snapshot` in the
metadata distinguishes it from an end-of-session capture made by the
SessionEnd hook (step 6). Using the session UUID as the Artifacta
`session_id` groups every capture of this session together; snapshots taken
at different points have different bytes, so dedup keeps each one.

## 5. Report the result

Tell the user: the artifact ID, filename, and size, plus how to get it back
later:

```bash
artifacta ls --session <session-uuid> --transcript
artifacta pull <artifact_id> -o ./transcript.jsonl
```

or via MCP: `list_artifacts` with `{"session_id": "<session-uuid>",
"transcript": true}`.

## 6. Offer automatic capture (opt-in, explicit consent required)

After a successful capture, offer — once, without pushing — to make this
automatic: a Claude Code `SessionEnd` hook that pushes the complete
transcript when each future session ends. **Do not install it without the
user's explicit yes.** An automatic hook uploads every future session's full
conversation, and Artifacta does not scan or redact secrets on push.

If the user consents:

1. Back up `~/.claude/settings.json` before touching it.
2. Merge the hook block **additively** into the existing settings — never
   replace the file wholesale; preserve every key already there.

The canonical hook block for `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/push-transcript.sh"
          }
        ]
      }
    ]
  }
}
```

Create `~/.claude/hooks/push-transcript.sh` with these exact contents:

```bash
#!/usr/bin/env bash
set -euo pipefail

INPUT="$(cat)"
SESSION_ID="$(echo "$INPUT" | jq -r '.session_id')"
TRANSCRIPT_PATH="$(echo "$INPUT" | jq -r '.transcript_path')"

if [[ -z "$SESSION_ID" || "$SESSION_ID" == "null" ]]; then
  echo "artifacta SessionEnd hook: missing session_id" >&2
  exit 1
fi
if [[ -z "$TRANSCRIPT_PATH" || "$TRANSCRIPT_PATH" == "null" || ! -f "$TRANSCRIPT_PATH" ]]; then
  echo "artifacta SessionEnd hook: missing transcript file: ${TRANSCRIPT_PATH:-}" >&2
  exit 1
fi

# Model capture (best-effort): metadata.model is the LAST MAIN-LOOP assistant
# model — sidechain (subagent) entries and "<synthetic>" placeholders are
# excluded. models_used lists every distinct model observed, sidechains
# included. Extraction failure degrades to a plain push, never a lost one.
MODEL="$(jq -r 'select(.type == "assistant" and .isSidechain != true) | .message.model // empty | select(. != "<synthetic>")' "$TRANSCRIPT_PATH" 2>/dev/null | tail -n 1 || true)"
MODELS_USED="$(jq -r 'select(.type == "assistant") | .message.model // empty | select(. != "<synthetic>")' "$TRANSCRIPT_PATH" 2>/dev/null | sort -u | paste -sd, - || true)"

if [[ -n "$MODEL" ]]; then
  artifacta push "$TRANSCRIPT_PATH" --session "$SESSION_ID" --transcript --meta "model=$MODEL" --meta "model_source=transcript" --meta "models_used=$MODELS_USED"
else
  artifacta push "$TRANSCRIPT_PATH" --session "$SESSION_ID" --transcript
fi
```

Do not modify the script — no logging, retries, fallback pushes, or
redaction. It requires the `artifacta` CLI (authenticated) and `jq` on
`PATH`.

Then make it executable and verify the install with all three checks
(each must exit `0`):

```bash
chmod 700 ~/.claude/hooks/push-transcript.sh
jq -e '[.hooks.SessionEnd[].hooks[]] | any(. == {"type":"command","command":"~/.claude/hooks/push-transcript.sh"})' ~/.claude/settings.json
bash -n ~/.claude/hooks/push-transcript.sh
test -x ~/.claude/hooks/push-transcript.sh
```

Hook captures carry no `capture=snapshot` metadata, which is how they're
told apart from this skill's mid-session snapshots.

## Standing caveats

- **No redaction on push.** Secrets in the conversation go into the
  artifact as-is; auditing content is the caller's responsibility. An
  optional source-checkout scanner exists at
  `mcp/typescript/scripts/secret-audit.ts` in the Artifacta repo.
- **Anthropic owns the transcript contract.** File location, the
  `SessionEnd` hook, and its stdin fields (`session_id`,
  `transcript_path`, `reason`) can change with Claude Code upgrades —
  re-verify after upgrading.
- **Claude Code only.** Codex CLI may have a comparable per-session file
  but is unverified and unsupported; ChatGPT keeps no local transcript.
- **Model capture is captured, not attested.** Artifacta records the model
  automatically from the agent runtime's own session log and freezes it at
  store time — a captured producer claim, not a cryptographic attestation.
  Session-level capture approximates per-artifact authorship: the transcript
  proves which models participated in the session, not which one emitted any
  specific artifact's bytes. Subagents spawned as separate sessions won't
  appear in the main transcript, so `models_used` is "models observed" —
  never claimed exhaustive.
