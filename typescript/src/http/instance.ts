// Module-level singleton for the Artifacta HTTP client.
//
// The client is instantiated once at startup (cli.ts) from a loaded Config
// and then read by tool / resource handlers via getHttpClient(). Keeping the
// reference here rather than on the Server instance avoids a circular import
// between server.ts (which exports VERSION) and http/client.ts (which imports
// VERSION).

import type { ArtifactaHttpClient } from "./client.js";
import { getRequestContext } from "./request-context.js";

let _client: ArtifactaHttpClient | undefined;

export function setHttpClient(client: ArtifactaHttpClient): void {
  _client = client;
}

export function getHttpClient(): ArtifactaHttpClient {
  // Hosted HTTP: each request carries its own key, so a request-scoped client
  // takes precedence (request-context.ts). Stdio leaves the store empty and
  // falls through to the process-wide singleton set at startup.
  const ctx = getRequestContext();
  if (ctx) return ctx.httpClient;
  if (!_client) {
    throw new Error(
      "HTTP client not initialised. Call setHttpClient() at startup before invoking tools or resources."
    );
  }
  return _client;
}

export function resetHttpClient(): void {
  _client = undefined;
}
