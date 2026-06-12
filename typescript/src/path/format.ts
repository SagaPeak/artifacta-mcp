export function formatOutsideAllowList(resolvedPath: string, allowRoots: string[]): string {
  const rootList = allowRoots.join(", ");
  return (
    `invalid_request: Path '${resolvedPath}' is outside the MCP server's allow-list.\n` +
    `Allow-listed roots: ${rootList} (default: server CWD)\n` +
    `Pass --allow-path=/Users/me/other-dir at launch to widen, or use the \`content\` field to send bytes inline.`
  );
}

export function formatDenied(resolvedPath: string, reason: string): string {
  return (
    `invalid_request: Path '${resolvedPath}' is outside the MCP server's allow-list.\n` +
    reason
  );
}

export function formatSizeExceeded(resolvedPath: string, fileSizeBytes: number): string {
  const gb = fileSizeBytes / (1024 ** 3);
  const sizeLabel =
    fileSizeBytes >= 1024 ** 3
      ? `${gb.toFixed(1)} GB`
      : `${(fileSizeBytes / (1024 ** 2)).toFixed(0)} MB`;
  return (
    `invalid_request: Path '${resolvedPath}' is ${sizeLabel}, exceeding the 500 MB direct-upload ceiling for store_artifact.path. ` +
    `Use request_upload_url for files >500 MB on Pro.`
  );
}

export function formatSpecialFile(resolvedPath: string): string {
  return (
    `invalid_request: Path '${resolvedPath}' is a special file (socket, device, FIFO, or symlink to special). ` +
    `Only regular files are accepted.`
  );
}

export function formatRelativeAllowPath(entry: string): string {
  return (
    `[artifacta-mcp] refusing to start: --allow-path entry '${entry}' is not an absolute path. ` +
    `All --allow-path and ARTIFACTA_MCP_ALLOW_PATH entries must be absolute paths.`
  );
}
