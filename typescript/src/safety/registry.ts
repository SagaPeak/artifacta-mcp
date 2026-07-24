import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ToolSafety = "safe" | "writeIdempotent" | "writeNonIdempotent" | "destructive";

/**
 * Per-call context threaded into tool handlers (AF_MCP-1.7).
 * Optional on the type so existing 0-arg stub handlers stay compatible.
 */
export interface ToolCallContext {
  /** Per-tool-call UUID; threaded through to the HTTP layer and surfaced in result _meta. */
  requestId: string;
  /**
   * The connected MCP client's `clientInfo.name` from the `initialize` handshake
   * (e.g. "claude-code"), when the transport exposes it. Undefined for stateless
   * HTTP calls that never replay `initialize`. Used by store_artifact (AF_MCP-PROV)
   * to auto-stamp `agent_id` when the caller didn't supply one.
   */
  clientName?: string;
}

export type ToolHandler = (
  args: Record<string, unknown> | undefined,
  ctx?: ToolCallContext
) => Promise<CallToolResult>;

const OPEN_WORLD_TOOL_NAMES = new Set([
  "create_download_link",
  "publish_artifact",
  "unpublish_artifact",
]);

const DESTRUCTIVE_ANNOTATION_TOOL_NAMES = new Set([
  "create_download_link",
  "delete_artifact",
  "seal_session",
  "publish_artifact",
  "unpublish_artifact",
]);

/** MCP ToolAnnotations per AF_MCP-1.5 / AF_MCP-REG-2 safety table. */
export function toolAnnotations(
  name: string,
  safety: ToolSafety
): NonNullable<Tool["annotations"]> {
  const annotations: NonNullable<Tool["annotations"]> = {
    readOnlyHint: safety === "safe",
    openWorldHint: OPEN_WORLD_TOOL_NAMES.has(name),
    destructiveHint: DESTRUCTIVE_ANNOTATION_TOOL_NAMES.has(name),
  };
  if (name === "store_artifact") {
    annotations.idempotentHint = true;
  }
  return annotations;
}

export interface ToolRegistration {
  tool: Tool;
  safety: ToolSafety;
  alwaysConfirm: boolean;
  handler: ToolHandler;
}

const _registry = new Map<string, ToolRegistration>();

// These tools get meta.requiresConfirmation when ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM=1
const WRITE_CONFIRM_TOOL_NAMES = new Set([
  "store_artifact",
  "request_upload_url",
  "complete_upload",
  "create_download_link",
]);

export function registerTool(
  tool: Tool,
  safety: ToolSafety,
  handler: ToolHandler,
  opts: { alwaysConfirm?: boolean } = {}
): void {
  const annotatedTool: Tool = {
    ...tool,
    annotations: tool.annotations ?? toolAnnotations(tool.name, safety),
  };
  _registry.set(tool.name, {
    tool: annotatedTool,
    safety,
    alwaysConfirm: opts.alwaysConfirm ?? false,
    handler,
  });
}

export interface FilterOpts {
  hasConfirmations: boolean;
  allowDestructive: boolean;
  writeConfirmRequired: boolean;
}

export function getFilteredTools(opts: FilterOpts): Tool[] {
  const result: Tool[] = [];
  for (const reg of _registry.values()) {
    const { tool, safety, alwaysConfirm } = reg;

    // Non-compliant client: destructive tools are absent unless --allow-destructive
    if (safety === "destructive" && !opts.hasConfirmations && !opts.allowDestructive) {
      continue;
    }

    let requiresConfirmation = false;
    if (opts.hasConfirmations) {
      if (safety === "destructive") requiresConfirmation = true;
      if (alwaysConfirm) requiresConfirmation = true;
      if (opts.writeConfirmRequired && WRITE_CONFIRM_TOOL_NAMES.has(tool.name)) {
        requiresConfirmation = true;
      }
    }

    result.push(
      requiresConfirmation
        ? { ...tool, _meta: { ...tool._meta, requiresConfirmation: true } }
        : tool
    );
  }
  return result;
}

/**
 * Server-side call-time gate — mirrors the tools/list filter.
 * Returns false when the tool must be blocked at dispatch (i.e. non-compliant
 * client without --allow-destructive calling a destructive tool directly).
 * Must be checked in the CallTool handler in addition to tools/list filtering.
 */
export function isCallPermitted(
  reg: ToolRegistration,
  hasConfirmations: boolean,
  allowDestructive: boolean
): boolean {
  if (reg.safety === "destructive" && !hasConfirmations && !allowDestructive) {
    return false;
  }
  return true;
}

export function getToolRegistration(name: string): ToolRegistration | undefined {
  return _registry.get(name);
}

export function clearRegistry(): void {
  _registry.clear();
}
