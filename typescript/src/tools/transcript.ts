export const TRANSCRIPT_CONTENT_TYPE = "application/x-ndjson";

export interface TranscriptWriteInput {
  contentType?: string;
  metadata?: Record<string, string>;
  model?: string;
  transcript: boolean;
}

export interface TranscriptWriteResult {
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface TranscriptListInput {
  metadata?: Record<string, string>;
  transcript: boolean;
}

function resolveCopiedMetadata(
  metadata: Record<string, string> | undefined,
  applyDefaults: (resolved: Record<string, string>) => void
): Record<string, string> | undefined {
  const resolved = { ...metadata };
  applyDefaults(resolved);
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Resolve model shorthand and transcript defaults without mutating caller input. */
export function resolveTranscriptWriteDefaults({
  contentType,
  metadata,
  model,
  transcript,
}: TranscriptWriteInput): TranscriptWriteResult {
  const resolvedMetadata = resolveCopiedMetadata(metadata, (resolved) => {
    if (model !== undefined && resolved.model === undefined) {
      resolved.model = model;
    }
    if (transcript && !("type" in resolved)) resolved.type = "transcript";
  });
  if (transcript) contentType ??= TRANSCRIPT_CONTENT_TYPE;

  return {
    contentType,
    metadata: resolvedMetadata,
  };
}

/** Resolve transcript list sugar without mutating caller metadata. */
export function resolveTranscriptListFilter({
  metadata,
  transcript,
}: TranscriptListInput): Record<string, string> | undefined {
  return resolveCopiedMetadata(metadata, (resolved) => {
    if (transcript && !("type" in resolved)) resolved.type = "transcript";
  });
}
