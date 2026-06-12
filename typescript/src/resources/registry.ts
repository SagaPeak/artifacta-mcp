// MCP Resource registry — module-level singleton mirroring the tool registry.
//
// Two surfaces:
//  1. Exact-URI resources (e.g. `artifacta://whoami`) registered via
//     `registerResource(resource, read)` — surfaced by `resources/list` and
//     dispatched on `resources/read` by URI lookup.
//  2. URI-template resources (e.g. `artifacta://artifact/{artifact_id}`)
//     registered via `registerResourceTemplate(template, read)` — surfaced
//     by `resources/templates/list` and dispatched on `resources/read` after
//     the exact-URI lookup misses.

import type {
  ReadResourceResult,
  Resource,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/types.js";

export type ResourceReader = (uri: string) => Promise<ReadResourceResult>;

export type TemplateResourceReader = (
  uri: string,
  params: Record<string, string>
) => Promise<ReadResourceResult>;

interface ResourceRegistration {
  resource: Resource;
  read: ResourceReader;
}

interface TemplateRegistration {
  template: ResourceTemplate;
  matcher: RegExp;
  paramNames: string[];
  read: TemplateResourceReader;
}

const _resources = new Map<string, ResourceRegistration>();
const _templates: TemplateRegistration[] = [];

export function registerResource(
  resource: Resource,
  read: ResourceReader
): void {
  _resources.set(resource.uri, { resource, read });
}

export function listResources(): Resource[] {
  return Array.from(_resources.values()).map((r) => r.resource);
}

export function getResourceReader(uri: string): ResourceReader | undefined {
  return _resources.get(uri)?.read;
}

/** Convert an RFC-6570-ish URI template into an anchored regex with named groups.
 *
 * `artifacta://artifact/{artifact_id}` ->
 *   /^artifacta:\/\/artifact\/(?<artifact_id>[^/]+)$/
 *
 * Per RFC 6570 simple expansion ({var}), captured segments do not contain `/`.
 * Anchoring with `^...$` prevents partial matches against longer URIs.
 */
function compileUriTemplate(uriTemplate: string): {
  matcher: RegExp;
  paramNames: string[];
} {
  const paramNames: string[] = [];
  // Split on `{name}` so we can escape literal segments and inject capture
  // groups in one pass.
  const parts: string[] = [];
  let cursor = 0;
  const re = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
  for (
    let match = re.exec(uriTemplate);
    match !== null;
    match = re.exec(uriTemplate)
  ) {
    const literal = uriTemplate.slice(cursor, match.index);
    parts.push(escapeRegex(literal));
    paramNames.push(match[1]);
    parts.push(`(?<${match[1]}>[^/]+)`);
    cursor = match.index + match[0].length;
  }
  parts.push(escapeRegex(uriTemplate.slice(cursor)));
  return { matcher: new RegExp(`^${parts.join("")}$`), paramNames };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function registerResourceTemplate(
  template: ResourceTemplate,
  read: TemplateResourceReader
): void {
  const { matcher, paramNames } = compileUriTemplate(template.uriTemplate);
  _templates.push({ template, matcher, paramNames, read });
}

export function listResourceTemplates(): ResourceTemplate[] {
  return _templates.map((t) => t.template);
}

export interface TemplateMatch {
  read: TemplateResourceReader;
  params: Record<string, string>;
}

export function matchResourceTemplate(uri: string): TemplateMatch | undefined {
  for (const reg of _templates) {
    const m = reg.matcher.exec(uri);
    if (m && m.groups) {
      const params: Record<string, string> = {};
      for (const name of reg.paramNames) {
        params[name] = m.groups[name];
      }
      return { read: reg.read, params };
    }
  }
  return undefined;
}

export function clearResourceRegistry(): void {
  _resources.clear();
  _templates.length = 0;
}
