// Module-level singleton for the path-confinement allow-list.
//
// cli.ts builds the allow-list once at startup via buildAllowList(argv) and
// stores the resolved roots here. The store_artifact path branch reads them via
// getAllowRoots() at handler time and hands them to checkPath(). Keeping the
// roots in a tiny module (mirroring http/instance.ts) avoids threading them
// through the Server instance or every tool signature.

let _roots: string[] | undefined;

export function setAllowRoots(roots: string[]): void {
  _roots = roots;
}

export function getAllowRoots(): string[] {
  if (!_roots) {
    throw new Error(
      "Path allow-list not initialised. Call setAllowRoots() at startup before invoking path-based tools."
    );
  }
  return _roots;
}

export function resetAllowRoots(): void {
  _roots = undefined;
}
