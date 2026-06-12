// Module-level singleton for the Artifacta HTTP client.
//
// The client is instantiated once at startup (cli.ts) from a loaded Config
// and then read by tool / resource handlers via getHttpClient(). Keeping the
// reference here rather than on the Server instance avoids a circular import
// between server.ts (which exports VERSION) and http/client.ts (which imports
// VERSION).

import type { ArtifactaHttpClient } from "./client.js";

let _client: ArtifactaHttpClient | undefined;

export function setHttpClient(client: ArtifactaHttpClient): void {
  _client = client;
}

export function getHttpClient(): ArtifactaHttpClient {
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
