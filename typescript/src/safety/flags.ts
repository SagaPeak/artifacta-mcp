export interface SafetyFlags {
  allowDestructive: boolean;
  writeConfirmRequired: boolean;
}

export function parseSafetyFlags(argv: string[]): SafetyFlags {
  return {
    // Only from CLI argv — not from env or config file (security design: §5 Notes)
    allowDestructive: argv.includes("--allow-destructive"),
    writeConfirmRequired: process.env.ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM === "1",
  };
}
