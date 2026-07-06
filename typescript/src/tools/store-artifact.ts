// AF_MCP-3.1 — store_artifact tool (content + path, with confinement).
//
// Dispatcher between the inline `content` (JSON+base64) path and the local
// `path` (streaming multipart) path. The input schema is plan §2.5 verbatim,
// including the structural `oneOf: [{required:[content]},{required:[path]}]`.
//
// DESCRIPTION DEVIATION (intentional — do not "restore verbatim"): plan §2.5's
// description claims path uploads reach "5 GB on Pro via the auto-fallback to
// presigned upload." The AF_MCP-3.1 scope boundary OVERRIDES this: there is NO
// auto-fallback in v1. Direct multipart handles up to 500 MB; files over 500 MB
// return `file_too_large`, and this description steers the agent to
// `request_upload_url` for them. QA AF_MCP-3.1.20/3.1.21 assert only that the
// description contains the confinement and crash-safe-idempotency language, so
// this behaviorally-accurate wording is compliant.

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { registerTool, type ToolCallContext } from "../safety/registry.js";
import { localInvalidRequest, type StoreArtifactArgs } from "./store-artifact-shared.js";
import { storeArtifactContent } from "./store-artifact-content.js";
import { storeArtifactPath } from "./store-artifact-path.js";
import { SESSION_ID_PATTERN, isSessionId } from "../ids/formats.js";

// Metadata key regex per CLAUDE.md — reject dots and leading digits at the schema.
const METADATA_KEY_PATTERN = "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$";
const METADATA_KEY_RE = new RegExp(METADATA_KEY_PATTERN);

// session_id format: alphanumeric start, alnum/./-/_ body, 1–128 chars.
// Constrained at the upload boundary so the MCP server cannot mint a
// session shape that seal_session cannot address (FastAPI's default path
// converter does not match URL-encoded slashes). See SESSION_ID_PATTERN
// in src/ids/formats.ts for the full rationale and defence-in-depth
// backlog note.

/**
 * Runtime validation of the `metadata` argument (the MCP SDK does not validate
 * inputSchema before dispatch). Mirrors the schema's patternProperties + value
 * maxLength. Returns an error message, or null when valid.
 */
function validateMetadata(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "`metadata` must be an object of string values";
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!METADATA_KEY_RE.test(k)) {
      return `metadata key '${k}' is invalid; keys must match ${METADATA_KEY_PATTERN}`;
    }
    if (typeof v !== "string") {
      return `metadata value for '${k}' must be a string`;
    }
    if (v.length > 1024) {
      return `metadata value for '${k}' exceeds the 1024-character limit`;
    }
  }
  return null;
}

export const STORE_ARTIFACT_DESCRIPTION =
  "Upload a file as a new artifact in a single call. Provide EITHER up to ~10 MB of " +
  "base64-encoded bytes via `content`, OR a local filesystem `path` that the MCP server " +
  "reads and streams as multipart/form-data (up to 500 MB). For files larger than 500 MB, " +
  "use `request_upload_url` (Pro only) instead — `store_artifact` returns `file_too_large` " +
  "for them. Tags the artifact with `session_id` / `agent_id` / `metadata` for later " +
  "retrieval and returns the full artifact record including its new `artifact_id` and " +
  "`content_hash`.\n\n" +
  "Path uploads are confined. The `path` argument is constrained to the launcher-configured " +
  "allow-list (default: the MCP server's CWD). Paths outside the allow-list, paths traversing " +
  "symlinks out of it, and paths to known-sensitive locations (`~/.ssh`, `~/.aws`, `/etc/`, " +
  "etc.) are refused with `invalid_request`. `path` also only works when the MCP server runs " +
  "on the same machine as the file — on the hosted server (mcp.artifacta.io) and the Claude " +
  "Code plugin it resolves inside the remote server's filesystem, never the caller's machine, " +
  "so use `content` (or `request_upload_url`) there.\n\n" +
  "For crash-safe retries, supply your own `idempotency_key` (any string ≤256 chars): a replay " +
  "within 24h returns the original artifact and never double-bills. If you omit it, the server " +
  "auto-generates one and returns it under `_meta.idempotency_key`, but that key protects only " +
  "in-process retries within a single call — it is lost if the server restarts, so pre-commit " +
  "your own key when durability matters.\n\n" +
  "Provenance: if you omit `agent_id`, the server stamps a default (the connected MCP client's " +
  "name, or \"mcp\") so that publishing this artifact later still produces a populated " +
  "provenance receipt. Pass your own `model` (e.g. \"claude-5\", \"gpt-5.5\") to record which " +
  "model generated this content — it is stored as `metadata.model` unless you already set that " +
  "key yourself in `metadata`, in which case your explicit value wins.";

export const STORE_ARTIFACT_TOOL: Tool = {
  name: "store_artifact",
  description: STORE_ARTIFACT_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      filename: { type: "string", minLength: 1, maxLength: 255 },
      content: {
        type: "string",
        contentEncoding: "base64",
        description:
          "Base64-encoded bytes. Use for content under 10 MB or when no local path is available.",
      },
      path: {
        type: "string",
        description:
          "Absolute local path inside the launcher-configured allow-list. The MCP server reads and streams this as multipart. Mutually exclusive with `content`. Paths outside the allow-list are refused.",
      },
      content_type: {
        type: "string",
        description: "MIME type. If omitted, guessed from filename.",
      },
      session_id: { type: "string", pattern: SESSION_ID_PATTERN },
      agent_id: { type: "string" },
      metadata: {
        type: "object",
        patternProperties: {
          [METADATA_KEY_PATTERN]: { type: "string", maxLength: 1024 },
        },
        additionalProperties: false,
      },
      ttl: {
        type: "string",
        description:
          "Duration suffix (e.g. `7d`, `30d`) or `never` (Pro only). Defaults to plan default.",
      },
      model: {
        type: "string",
        maxLength: 128,
        description:
          "Model identifier that generated this content (e.g. \"claude-5\", \"gpt-5.5\"). " +
          "Stored as `metadata.model` for the provenance receipt on published pages; ignored " +
          "if `metadata.model` is already set explicitly.",
      },
      idempotency_key: { type: "string", minLength: 1, maxLength: 256 },
    },
    required: ["filename"],
    oneOf: [{ required: ["content"] }, { required: ["path"] }],
    additionalProperties: false,
  },
};

export const storeArtifactHandler = async (
  args: Record<string, unknown> | undefined,
  ctx?: ToolCallContext
): Promise<CallToolResult> => {
  const a: Record<string, unknown> = args ?? {};

  // The MCP SDK does not validate inputSchema before dispatch, so a
  // non-compliant client can send wrong types / out-of-range values / both or
  // neither body source. Validate every field here so malformed input returns a
  // structured invalid_request instead of crashing into internal_error (e.g.
  // Buffer.from(number) throwing) or being forwarded unverified to the API.
  if (typeof a.filename !== "string" || a.filename.length < 1 || a.filename.length > 255) {
    return localInvalidRequest(
      "`filename` is required and must be a string of 1-255 characters"
    );
  }

  // oneOf: exactly one of `content` or `path`.
  const hasContent = a.content !== undefined;
  const hasPath = a.path !== undefined;
  if (hasContent && hasPath) {
    return localInvalidRequest("provide exactly one of `content` or `path`, not both");
  }
  if (!hasContent && !hasPath) {
    return localInvalidRequest("provide exactly one of `content` or `path`");
  }

  // Type-check the chosen body source (these values are consumed directly by the
  // sub-handlers — a non-string would otherwise throw).
  if (hasContent && typeof a.content !== "string") {
    return localInvalidRequest("`content` must be a base64-encoded string");
  }
  if (hasPath && typeof a.path !== "string") {
    return localInvalidRequest("`path` must be a string");
  }

  // Optional string fields.
  for (const key of ["content_type", "session_id", "agent_id", "ttl", "model"] as const) {
    if (a[key] !== undefined && typeof a[key] !== "string") {
      return localInvalidRequest(`\`${key}\` must be a string`);
    }
  }

  // session_id format gate — defence at the upload boundary. The schema
  // `pattern` is the primary contract; this runtime guard catches
  // non-compliant clients that bypass schema validation.
  if (a.session_id !== undefined && !isSessionId(a.session_id as string)) {
    return localInvalidRequest(
      `\`session_id\` must match ${SESSION_ID_PATTERN} (alphanumeric start; alnum, dot, underscore, hyphen body; 1–128 chars)`
    );
  }

  // idempotency_key: optional string, 1-256 chars (becomes an HTTP header value).
  if (a.idempotency_key !== undefined) {
    if (
      typeof a.idempotency_key !== "string" ||
      a.idempotency_key.length < 1 ||
      a.idempotency_key.length > 256
    ) {
      return localInvalidRequest("`idempotency_key` must be a string of 1-256 characters");
    }
  }

  // metadata: optional object of string values with constrained keys.
  if (a.metadata !== undefined) {
    const metaError = validateMetadata(a.metadata);
    if (metaError) return localInvalidRequest(metaError);
  }

  // `model` shorthand folds into `metadata.model` unless the caller already set
  // that key explicitly in `metadata` (explicit metadata wins — see tool
  // description). Build a fresh metadata object rather than mutating `a.metadata`.
  const metadata: Record<string, string> = {
    ...(a.metadata as Record<string, string> | undefined),
  };
  if (typeof a.model === "string" && metadata.model === undefined) {
    metadata.model = a.model;
  }

  // Provenance auto-stamp (AF_MCP-PROV): publish_artifact_page re-derives its
  // provenance receipt from the artifact's own `agent_id` / `metadata.model` at
  // publish time — it takes no provenance params of its own — so an untagged
  // upload here would silently produce an empty receipt later. Stamp a default
  // agent_id when the caller didn't supply one: the connected MCP client's name
  // if the transport exposed it during `initialize`, else the literal "mcp".
  const agentId = typeof a.agent_id === "string" ? a.agent_id : ctx?.clientName ?? "mcp";

  const finalArgs: StoreArtifactArgs = {
    filename: a.filename as string,
    content: hasContent ? (a.content as string) : undefined,
    path: hasPath ? (a.path as string) : undefined,
    content_type: a.content_type as string | undefined,
    session_id: a.session_id as string | undefined,
    agent_id: agentId,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    ttl: a.ttl as string | undefined,
    idempotency_key: a.idempotency_key as string | undefined,
  };

  if (hasContent) {
    return storeArtifactContent(finalArgs, ctx);
  }
  return storeArtifactPath(finalArgs, ctx);
};

export function registerStoreArtifactTool(): void {
  // safety: "writeIdempotent" — quota-bounded, idempotency-key protected,
  // reversible via delete_artifact. Promotable to requiresConfirmation via
  // ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM=1 (handled by the registry).
  registerTool(STORE_ARTIFACT_TOOL, "writeIdempotent", storeArtifactHandler);
}
