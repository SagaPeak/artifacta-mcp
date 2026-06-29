// Central registration entry point for production tools and resources.
//
// cli.ts calls registerAllTools() and registerAllResources() once at startup,
// after the HTTP client and config are wired. Tests that exercise the full
// surface (e.g. test/schema-validation.test.ts) call the same functions to
// keep the parametric gates honest against the real registrations.

import { registerWhoamiTool } from "./whoami.js";
import { registerListArtifactsTool } from "./list-artifacts.js";
import { registerGetArtifactTool } from "./get-artifact.js";
import { registerGetArtifactDownloadUrlTool } from "./get-artifact-download-url.js";
import { registerListSessionsTool } from "./list-sessions.js";
import { registerStoreArtifactTool } from "./store-artifact.js";
import { registerRequestUploadUrlTool } from "./request-upload-url.js";
import { registerCompleteUploadTool } from "./complete-upload.js";
import { registerCreateDownloadLinkTool } from "./create-download-link.js";
import { registerDeleteArtifactTool } from "./delete-artifact.js";
import { registerSealSessionTool } from "./seal-session.js";
import { registerPublishArtifactTool } from "./publish-artifact.js";
import { registerUnpublishArtifactTool } from "./unpublish-artifact.js";
import { registerWhoamiResource } from "../resources/whoami.js";
import { registerArtifactResource } from "../resources/artifact.js";
import { registerArtifactBytesResource } from "../resources/artifact-bytes.js";
import { registerSessionResource } from "../resources/session.js";

export function registerAllTools(): void {
  registerWhoamiTool();
  registerListArtifactsTool();
  registerGetArtifactTool();
  registerGetArtifactDownloadUrlTool();
  registerListSessionsTool();
  registerStoreArtifactTool();
  registerRequestUploadUrlTool();
  registerCompleteUploadTool();
  registerCreateDownloadLinkTool();
  registerDeleteArtifactTool();
  registerSealSessionTool();
  registerPublishArtifactTool();
  registerUnpublishArtifactTool();
}

export function registerAllResources(): void {
  registerWhoamiResource();
  registerArtifactResource();
  registerArtifactBytesResource();
  registerSessionResource();
}
