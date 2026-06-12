import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Built-in deny-list — always wins over allow-list. Hard-coded for security; not extensible via flag.
// Returns an array of absolute path prefixes that are always denied.
export function buildDenyRoots(): string[] {
  const home = homedir();
  return [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".config", "gh"),
    join(home, ".kube"),
    join(home, ".artifacta"),
    // .netrc is a file, not a dir — handled separately
    join(home, ".netrc"),
    join(home, "Library", "Keychains"),
    "/etc",
    "/var/lib",
    "/proc",
    "/sys",
    "/dev",
    "/private/etc",
  ];
}

function resolveDenyRoot(root: string): string {
  try { return realpathSync(root); } catch { return root; }
}

// Include both raw and canonicalized forms so that deny roots that are symlinks
// (e.g. /var → /private/var on macOS, or a network-mounted $HOME) are still matched
// against the fully-resolved path returned by checkPath's realpathSync call.
const RAW_DENY_ROOTS = buildDenyRoots();
const DENY_ROOTS: string[] = [
  ...new Set([...RAW_DENY_ROOTS, ...RAW_DENY_ROOTS.map(resolveDenyRoot)]),
];

// Pattern-based deny rules (filename patterns checked against the resolved path)
export const DENY_FILENAME_PATTERNS: RegExp[] = [
  // credentials.json anywhere
  /(?:^|\/)credentials\.json$/,
  // .env files anywhere (e.g. .env, .env.local, .env.production)
  /(?:^|\/)\.env(?:\.|$)/,
];

/**
 * Returns the deny reason if `resolvedPath` matches a deny rule, or null if not denied.
 * `resolvedPath` must already be canonicalized via realpathSync.
 */
export function checkDenyList(resolvedPath: string): string | null {
  for (const root of DENY_ROOTS) {
    if (resolvedPath === root || resolvedPath.startsWith(root + "/")) {
      return `Path '${resolvedPath}' matches built-in deny-list entry '${root}'`;
    }
  }
  for (const pattern of DENY_FILENAME_PATTERNS) {
    if (pattern.test(resolvedPath)) {
      return `Path '${resolvedPath}' matches deny-list filename pattern`;
    }
  }
  return null;
}
