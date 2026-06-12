const SECRET_PATTERN =
  /(['""]?(?:api[_-]?key|password|secret|token|auth)['""]?\s*[:=]\s*['""]?)([^\s"',}\]]{4,})/gi;

function redactSecrets(s: string): string {
  return s.replace(SECRET_PATTERN, "$1[REDACTED]");
}

export function emitDestructiveAudit(toolName: string, args: unknown): void {
  let argsStr: string;
  try {
    argsStr = JSON.stringify(args) ?? "";
  } catch {
    argsStr = String(args);
  }
  argsStr = redactSecrets(argsStr);
  if (argsStr.length > 200) {
    argsStr = argsStr.slice(0, 200) + "...";
  }
  process.stderr.write(
    `[artifacta-mcp] destructive call: ${toolName}(${argsStr}) — no confirmation surface\n`
  );
}
