# Changelog

All notable changes to `@artifacta-mcp/mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] — 2026-06-05

Registry distribution metadata only — no runtime or tool-surface changes.

### Added

- `mcpName: io.artifacta/mcp` in `package.json` for official MCP Registry ownership verification (AF_MCP-REG-3).
- MCP tool safety annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) on all 11 tools for registry indexers (AF_MCP-REG-2).

## [1.0.0] — 2026-05-28

Destructive tools. Agents can now delete artifacts and seal sessions over the
same stdio transport as v0.2. The autonomy-boundary gating that shipped dormant
in v0.1 and that v0.2 used for `create_download_link` is now load-bearing for
the two irreversible operations. `1.0.0` signals a stable contract — no
further breaking changes to the existing 11 tools / 4 resources without v2.

### Tools

- `delete_artifact` — soft-delete an artifact by id. Maps to
  `DELETE /v1/artifacts/{artifact_id}`. Classified **destructive**: filtered
  from `tools/list` for clients that do not advertise
  `experimental.confirmations` (unless `--allow-destructive` is set), and
  carries `requiresConfirmation` for compliant clients. Replay-safe — a second
  call on an already-deleted artifact returns
  `{ artifact_id, deleted: true, already_deleted: true }` instead of an error,
  so a retry after partial visibility is harmless. No `Idempotency-Key`
  injection (the API gates injection to `POST /v1/artifacts` only); the
  retry policy is `idempotentWrite` (429 once, 5xx up to 3× with jitter)
  because the operation is naturally idempotent.
- `seal_session` — mark a session as **irreversible** (no `unseal`). Maps to
  `POST /v1/sessions/{session_id}/seal`. Same destructive classification,
  same gating, same retry policy. A re-seal of an already-sealed session is a
  passthrough at the API layer (returns the existing `sealed_at`), so the MCP
  surface is naturally idempotent without any synthesized success-on-replay
  shape.

### Security

- **Destructive-tool gating is now the load-bearing consent surface for two
  irreversible operations.** Plan §5.2 classification table:
  `delete_artifact` and `seal_session` are *destructive* — the same gating
  used in v0.2 for `create_download_link` now governs all three. Compliant
  clients (those advertising `experimental.confirmations` in `initialize`)
  receive `requiresConfirmation: true` and prompt before each call;
  non-compliant clients (e.g. Claude Desktop, Cursor) do not see the tools
  in `tools/list` at all. The only override is the per-launch
  `--allow-destructive` CLI flag — **never read from the environment or
  `mcp.toml`** — and each destructive call under that flag emits a one-line
  stderr audit `[artifacta-mcp] destructive call: <tool>(<args>)`.
- The `ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM=1` env override continues to
  promote `requiresConfirmation` on the write tools (`store_artifact`,
  `request_upload_url`, `complete_upload`, `create_download_link`) for
  compliant clients that want a stricter confirmation surface than the
  default. It does **not** affect destructive tools — those always require
  confirmation on compliant clients.
- Path confinement (AF_MCP-1.6) and `Idempotency-Key` auto-injection on
  `POST /v1/artifacts` (§6.2) are unchanged from v0.2. All
  path-confinement denial tests pass — the hard gate for the v1.0 cut.

### Error contract

- No new error codes. `delete_artifact` translates `artifact_not_found`,
  `unauthorized`, and `rate_limited` to their §6 agent-readable summaries;
  the `artifact_already_deleted` 410 path is synthesized as success-on-replay
  (per §6.1) rather than translated as an error. `seal_session` translates
  `session_not_found`, `unauthorized`, and `rate_limited`; the empty-session
  AF_CLI-2.1 semantics surface unchanged.

### Tested against

- Node 20 (engines field) and the Artifacta REST API at
  `https://api.artifacta.io` (v1). New endpoints exercised:
  `DELETE /v1/artifacts/{id}`, `POST /v1/sessions/{id}/seal`.

### Migration from 0.2

- **No behavior change for existing tools.** All v0.2 tools (`whoami`,
  `list_artifacts`, `get_artifact`, `get_artifact_download_url`,
  `list_sessions`, `store_artifact`, `request_upload_url`, `complete_upload`,
  `create_download_link`) and resources are byte-for-byte the same — same
  schemas, same responses, same error contract. The only change agents
  observe is that **the tool list grows** for compliant clients (or for any
  client launched with `--allow-destructive`): `delete_artifact` and
  `seal_session` appear in `tools/list`.
- No config migration is required. Hosts that previously launched the server
  with `--allow-destructive` (Claude Desktop / Cursor configs that wanted
  `create_download_link`) now expose `delete_artifact` and `seal_session`
  on the same flag. If you want to scope the flag back, narrow the host
  config or move to a client that advertises `experimental.confirmations`.

### Not yet shipped

These remain out of scope for v1.0 and are tracked separately:

- **Hosted SSE transport** (`mcp.artifacta.io`): Phase 4 of the plan,
  blocked indefinitely on the delegated-auth design, per-connection
  isolation review, and tenant-scoped key scopes. No timeline. See
  `docs/tasks/mcp/Artifacta_Tasks_MCP_Phase4_HostedSSE.md`.
- **Python package (`artifacta-mcp` on PyPI)**: scheduled for Phase 10a
  (AF_MCP-6.2).
- **Framework integrations** (LangChain / LlamaIndex / Mastra / etc.):
  scheduled for Phase 10b (AF_MCP-6.3–6.7).
- **Destructive-tool confirmation telemetry (≥99% user-confirmed)**:
  deferred to the post-launch backlog (`AF_MCP-PL-3`); the gating mechanism
  ships now, the metric dashboard ships later.

## [0.2.0] — 2026-05-25

Write tools. Agents can now produce, persist, and share artifacts end-to-end —
inline or from a confined local path — over the same stdio transport as v0.1.
The path-confinement engine and `Idempotency-Key` injection that shipped dormant
in v0.1 are now load-bearing.

### Tools

- `store_artifact` — create an artifact two ways: `content` (inline, base64,
  ≤10 MB) or `path` (a local file, streamed as multipart). Local paths are
  subject to the path-confinement engine (see Security) and a 500 MB ceiling;
  the description steers to `request_upload_url` for larger or Pro-tier uploads.
  An `Idempotency-Key` is auto-injected (`mcp_<uuid4>`) unless the caller
  supplies their own, so a crash-and-replay returns the same artifact rather
  than a duplicate. `_meta.idempotency_key` is surfaced on success as the
  explicit replay hook.
- `request_upload_url` — mint a presigned R2 upload URL for large/Pro uploads
  (Free tier receives `quota_exceeded` with an upgrade URL). Non-idempotent:
  on a 5xx/network failure it makes **one** HTTP call and returns the §6.1
  ambiguous-completion guidance rather than blindly retrying.
- `complete_upload` — finalize a presigned upload into a committed artifact.
  Naturally idempotent (the API returns the existing record for an already-
  active artifact), so it auto-retries 5xx safely.
- `create_download_link` — mint a public, shareable `dl.artifacta.io/lnk_…`
  download link (default expiry 7 days). Classified **destructive** for consent:
  filtered from `tools/list` for clients that do not advertise
  `experimental.confirmations` (unless `--allow-destructive` is set), carries
  `requiresConfirmation` for compliant clients, and emits a one-line stderr
  audit per call. Non-idempotent — one HTTP call on 5xx, with §6.1 guidance.

### Resources

- `artifacta://artifact/{artifact_id}/bytes` — inline byte preview of an
  artifact (text or blob, routed by content type), gated at 100 MB; larger
  artifacts steer the agent to `get_artifact_download_url`.

### Security

- The **local path-confinement engine** is now enforced for `store_artifact`'s
  `path` argument: default-deny allow-list rooted at the server's working
  directory, extendable with `--allow-path=<dir>`, with a deny-list that always
  wins (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.kube`, `~/.netrc`,
  `~/.artifacta`, `/etc`, `~/Library/Keychains`, `credentials.json`, `.env*`).
  Symlinks are resolved via `realpath()` before the allow-list check, and
  special files (sockets/FIFOs/devices) are refused. **All path-confinement
  denial tests pass — this is the hard gate for the v0.2 cut.**
- `create_download_link` is consent-gated as described above — agents do not
  silently leak public URLs.

### Error contract

- The §6.1 ambiguous-completion guidance is now reachable on the 5xx paths of
  the non-idempotent write tools (`request_upload_url`, `create_download_link`):
  the agent is told to verify state or escalate rather than retry and risk a
  duplicate write.

### Tested against

- Node 20 (engines field) and the Artifacta REST API at
  `https://api.artifacta.io` (v1). New endpoints exercised: `POST /v1/artifacts`
  (multipart + JSON), `POST /v1/artifacts/upload-url`,
  `POST /v1/artifacts/{id}/complete`, `POST /v1/artifacts/{id}/links`.

### Migration from 0.1

- **No behavior change for existing tools.** `whoami`, `list_artifacts`,
  `get_artifact`, `get_artifact_download_url`, and `list_sessions` are
  byte-for-byte the same as v0.1 — same schemas, same responses, same error
  contract. The only change agents observe is that **the tool list grows**: the
  four write tools and the `…/bytes` resource appear in `tools/list` /
  `resources/list`. No config migration is required; upgrade by letting `npx`
  resolve `@artifacta-mcp/mcp@0.2.0`.

### Not yet shipped

These remain out of scope for v0.2 and are gated on later phases:

- **Destructive tools — deferred to Phase 3 (v1.0)**: `delete_artifact`,
  `seal_session`. The confirmation-capability gating and `--allow-destructive`
  audit trail already ship (and now gate `create_download_link`), so the
  mechanism is battle-tested before delete/seal use it.
- **Hosted SSE transport** (`mcp.artifacta.io`): blocked on the delegated-auth
  design and per-connection isolation review. No timeline.
- **Python package (`artifacta-mcp` on PyPI)**: scheduled for Phase 10a
  (AF_MCP-6.2).

## [0.1.0] — 2026-05-08

First public release. Read-only artifact tools for the Artifacta API exposed
over the Model Context Protocol stdio transport. Targets Claude Desktop,
Cursor, and any MCP-compatible client running on Node 20+.

### Tools

- `whoami` — return the calling tenant's identity, plan, usage counters, and
  rate limits. Free of side effects.
- `list_artifacts` — paginated artifact listing with metadata-key filters,
  session/agent filters, time-window filters, and `created_at DESC,
  artifact_id DESC` cursor pagination.
- `get_artifact` — fetch one artifact's metadata by ID. Tenant-internal fields
  (`tenant_id`, `deleted_at`) are stripped at the MCP boundary.
- `get_artifact_download_url` — mint a 1-hour presigned URL for direct R2
  fetch. Description steers the agent to `create_download_link` when the URL
  is for human sharing.
- `list_sessions` — aggregated session view (artifact counts, last-modified,
  is_sealed). Cursor-paginated.

### Resources

- `artifacta://whoami` — same payload as the `whoami` tool, exposed as a
  resource for clients that prefer a static surface.
- `artifacta://artifact/{artifact_id}` — per-artifact resource template;
  identical body to `get_artifact`.
- `artifacta://session/{session_id}` — aggregate view of a session's artifacts
  + seal state.

### Server runtime

- Stdio JSON-RPC transport with capabilities `tools.listChanged: false`,
  `resources.{listChanged: false, subscribe: false}`, `prompts: {}`,
  `logging: {}` advertised in `initialize`.
- Graceful shutdown: SIGTERM, stdin EOF, and the non-standard `shutdown`
  JSON-RPC method all exit 0 within 5 seconds.
- Configuration sources, in priority order: `--api-key`/`--api-url` CLI flag,
  `ARTIFACTA_API_KEY`/`ARTIFACTA_API_URL` env vars, `~/.artifacta/mcp.toml`
  with profile selection. POSIX-mode permission check on Linux/macOS rejects
  world-readable config files; Windows emits a one-time stderr warning.
- HTTP layer with `undici` connection pooling (10 keep-alive sockets, 30 s idle
  timeout), per-tool retry policies, automatic `Idempotency-Key` injection on
  `POST /v1/artifacts`, and a 3-consecutive-failure outage notifier.
- 8-level MCP logging (default `notice`); all log lines stderr-only, single
  JSON, never stdout. Per-call `request_id` UUID surfaced in `_meta` and log
  lines.
- Anonymous opt-in telemetry (`--telemetry=on`): hard-coded 5-field
  allow-list; never includes argument values, response bodies, or any string
  from the user's data plane.

### Security

- **Local path-confinement engine** (active when write tools land in v0.2):
  default-deny allow-list rooted at server CWD; deny-list overrides for
  `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.kube`, `~/.netrc`,
  `~/.artifacta`, `/etc`, `~/Library/Keychains`, `credentials.json`, and
  `.env*`. Symlinks are resolved via `realpath()` before allow-list checks.
  500 MB direct-upload ceiling with `request_upload_url` named as the >500 MB
  alternative on Pro.
- **Autonomy-boundary gating**: destructive tools (when shipped in v1.0) are
  filtered from `tools/list` for clients that do not advertise
  `experimental.confirmations` in `initialize`. The only override is the
  per-launch `--allow-destructive` CLI flag — never read from the
  environment. Each destructive call under that flag emits a one-line stderr
  audit.

### Error contract

- Every Artifacta API error code in the v1 taxonomy translates to an
  agent-readable summary at the MCP boundary. The §6.1 ambiguous-completion
  guidance fires on non-idempotent write 5xx (Phase 2 wiring).
- `unauthorized` failures surface the §4.3 remediation template, including
  the last-known key suffix when one was previously cached via `whoami`.
- Tenant-suspended (deletion-grace) responses route to a dedicated summary
  pointing at the dashboard account page.

### Tested against

- Node 20 (engines field). Earlier Node versions fail the engine check before
  any tool executes.
- The Artifacta REST API at `https://api.artifacta.io` (v1).

### Not yet shipped

These are explicitly out of scope for v0.1 and gated on later phases:

- **Write tools — deferred to Phase 2 (v0.2)**: `store_artifact`,
  `request_upload_url`, `complete_upload`, `create_download_link`. The
  path-confinement engine and Idempotency-Key injection ship now so they are
  battle-tested before write traffic uses them.
- **Destructive tools — deferred to Phase 3 (v1.0)**: `delete_artifact`,
  `seal_session`. Confirmation-capability gating and the
  `--allow-destructive` audit trail ship now for the same reason.
- **Hosted SSE transport** (`mcp.artifacta.io`): blocked on the delegated-auth
  design and per-connection isolation review. No timeline.
- **Python package (`artifacta-mcp` on PyPI)**: scheduled for Phase 10a
  (AF_MCP-6.2). Will reuse the existing `artifacta` PyPI SDK for the HTTP
  layer.
