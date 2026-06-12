// ID format definitions per CLAUDE.md.
// These regex strings are the contract — the same patterns are wired into
// every tool input schema that accepts an artifact id, link id, or API key.

export const ARTIFACT_ID_PATTERN = "^art_[A-Za-z0-9]{16}$";
export const DOWNLOAD_LINK_ID_PATTERN = "^lnk_[A-Za-z0-9]{20}$";
export const API_KEY_PATTERN = "^ak_live_[A-Za-z0-9]{32}$";

// session_id is a user-supplied label (spec: ARTIFACTA_MVP_SPEC_v5 §"an
// optional, user-defined string grouping artifacts"). The spec leaves the
// format free-form, but the seal endpoint uses the value as a URL path
// segment (POST /v1/sessions/{session_id}/seal). FastAPI's default path
// converter decodes %2F back to / before route matching, so a session_id
// containing path-significant characters cannot be sealed even after URL
// encoding — agents could create-then-fail-to-seal valid sessions. This
// pattern is the MCP-boundary defence: alphanumeric start, then any of
// alnum/dot/underscore/hyphen, 1–128 chars total. Accepts every spec
// example (pipeline_run_42, daily_batch_20260313, experiment-v3) and the
// SDK auto-generated `ses_<12-alnum>` form (cli/src/artifacta/sdk.py:761).
// Rejects /, ?, #, %, space, control chars, Unicode.
//
// Defence-in-depth backlog: API-side validation in api/app/routers/
// artifacts.py upload handlers + api/app/routers/sessions.py would close
// the loop for direct-API callers (the MCP fix only covers the AI-agent
// surface). See CHANGELOG note for v1.0.
export const SESSION_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";

const ARTIFACT_ID_RE = new RegExp(ARTIFACT_ID_PATTERN);
const DOWNLOAD_LINK_ID_RE = new RegExp(DOWNLOAD_LINK_ID_PATTERN);
const API_KEY_RE = new RegExp(API_KEY_PATTERN);
const SESSION_ID_RE = new RegExp(SESSION_ID_PATTERN);

export function isArtifactId(value: string): boolean {
  return ARTIFACT_ID_RE.test(value);
}

export function isDownloadLinkId(value: string): boolean {
  return DOWNLOAD_LINK_ID_RE.test(value);
}

export function isApiKey(value: string): boolean {
  return API_KEY_RE.test(value);
}

export function isSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}
