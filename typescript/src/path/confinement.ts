import { openSync, fstatSync, closeSync, realpathSync, statSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import { checkDenyList } from "./denylist.js";
import {
  formatOutsideAllowList,
  formatDenied,
  formatSizeExceeded,
  formatSpecialFile,
  formatRelativeAllowPath,
} from "./format.js";

export const MAX_PATH_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB

// O_NOFOLLOW is defined on POSIX; undefined/0 on Windows — fall back to 0.
const O_NOFOLLOW: number = (constants as Record<string, number | undefined>)["O_NOFOLLOW"] ?? 0;

// Resolve a path through symlinks; fall back to as-is if it doesn't exist yet.
function resolveRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

export type ConfinementResult =
  // fd is an open file descriptor — CALLER MUST CLOSE IT with closeSync(fd) or createReadStream({ fd }).
  // Using a returned fd eliminates the TOCTOU window between path validation and file open.
  //
  // size / mtimeMs / ino are captured from the same fstat used for the ceiling
  // check. Callers that stream the fd MUST bound the read to `size` and re-verify
  // size+mtimeMs before each (re)read so that a file mutated in place after the
  // check cannot bypass the size ceiling or break a byte-identical retry.
  | { ok: true; resolvedPath: string; fd: number; size: number; mtimeMs: number; ino: number }
  | { ok: false; reason: string };

// Mode bits
const S_IFREG = 0o100000;
const S_IFMT = 0o170000;

function isRegularFile(mode: number): boolean {
  return (mode & S_IFMT) === S_IFREG;
}

/**
 * Parses and validates the allow-list at server startup.
 * Exits with code 2 if a relative path is found.
 * Returns the absolute resolved allow-list roots.
 */
export function buildAllowList(argv: string[]): string[] {
  const roots: string[] = [resolveRoot(process.cwd())];

  // --allow-path can appear as --allow-path=/abs/p1:/abs/p2 or --allow-path /abs/p1
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let value: string | undefined;
    if (arg.startsWith("--allow-path=")) {
      value = arg.slice("--allow-path=".length);
    } else if (arg === "--allow-path" && i + 1 < argv.length) {
      value = argv[++i];
    }
    if (value !== undefined) {
      for (const entry of value.split(":").filter(Boolean)) {
        if (!isAbsolute(entry)) {
          process.stderr.write(formatRelativeAllowPath(entry) + "\n");
          process.exit(2);
        }
        roots.push(resolveRoot(entry));
      }
    }
  }

  // ARTIFACTA_MCP_ALLOW_PATH env var (colon-separated)
  const envPaths = process.env.ARTIFACTA_MCP_ALLOW_PATH;
  if (envPaths) {
    for (const entry of envPaths.split(":").filter(Boolean)) {
      if (!isAbsolute(entry)) {
        process.stderr.write(formatRelativeAllowPath(entry) + "\n");
        process.exit(2);
      }
      roots.push(resolveRoot(entry));
    }
  }

  return roots;
}

/**
 * Logs the allow-list to stderr at startup. Call once after buildAllowList().
 */
export function logAllowList(roots: string[]): void {
  process.stderr.write(`[artifacta-mcp] path allow-list: ${roots.join(", ")}\n`);
}

/**
 * Engine check — call this before reading any filesystem path from a tool argument.
 *
 * @param inputPath - The raw path string from the tool argument
 * @param allowRoots - The allow-list built at startup via buildAllowList()
 * @param ceilingBytes - The transport-specific upload ceiling for the calling tool
 */
export function checkPath(
  inputPath: string,
  allowRoots: string[],
  ceilingBytes: number = MAX_PATH_UPLOAD_BYTES
): ConfinementResult {
  // Step 1: resolve all symlinks in the path — detect deny/allow before opening.
  let resolved: string;
  try {
    resolved = realpathSync(inputPath);
  } catch (err) {
    return {
      ok: false,
      reason: `invalid_request: Path '${inputPath}' cannot be resolved: ${(err as Error).message}`,
    };
  }

  // Step 2: deny-list check — fast, no I/O, run before opening.
  const denyReason = checkDenyList(resolved);
  if (denyReason !== null) {
    return { ok: false, reason: formatDenied(resolved, denyReason) };
  }

  // Step 3: allow-list membership check — fast, no I/O, run before opening.
  const inAllowList = allowRoots.some(
    (root) => resolved === root || resolved.startsWith(root + "/")
  );
  if (!inAllowList) {
    return { ok: false, reason: formatOutsideAllowList(resolved, allowRoots) };
  }

  // Step 3.5: pre-open stat. Catches special files (sockets, FIFOs, devices)
  // whose `openSync(O_RDONLY)` would fail with EOPNOTSUPP/ENXIO before fstat
  // can classify them. The post-open fstat in step 6 stays as the
  // race-detection guard (file swapped between stat and open).
  try {
    const earlyStat = statSync(resolved);
    if (!isRegularFile(earlyStat.mode)) {
      return { ok: false, reason: formatSpecialFile(resolved) };
    }
  } catch {
    // If stat throws (ENOENT, permission, etc.) fall through — the openSync
    // path produces the more specific error.
  }

  // Step 4: open with O_NOFOLLOW to close the TOCTOU window.
  // If `resolved` was swapped for a symlink after realpathSync(), this fails with ELOOP.
  let fd: number;
  try {
    fd = openSync(resolved, constants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    return {
      ok: false,
      reason: `invalid_request: Path '${resolved}' cannot be opened: ${(err as Error).message}`,
    };
  }

  // Step 5: stat via the open fd — immune to any race after step 4.
  let stat: ReturnType<typeof fstatSync>;
  try {
    stat = fstatSync(fd);
  } catch (err) {
    closeSync(fd);
    return {
      ok: false,
      reason: `invalid_request: Path '${resolved}' cannot be stat'd: ${(err as Error).message}`,
    };
  }

  // Step 6: reject special files (sockets, FIFOs, char/block devices).
  if (!isRegularFile(stat.mode)) {
    closeSync(fd);
    return { ok: false, reason: formatSpecialFile(resolved) };
  }

  // Step 7: size ceiling check (tool-specific).
  if (stat.size > ceilingBytes) {
    closeSync(fd);
    return { ok: false, reason: formatSizeExceeded(resolved, stat.size) };
  }

  // Caller MUST close fd when done (createReadStream({ fd }) or closeSync(fd)).
  // size/mtimeMs/ino come from the fstat above — used by streaming callers to
  // bound the read and detect post-check in-place mutation.
  return {
    ok: true,
    resolvedPath: resolved,
    fd,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ino: stat.ino,
  };
}
