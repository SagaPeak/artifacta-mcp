"""artifacta-mcp CLI entry point.

Parses `--version`, `--allow-destructive`, `--allow-path`, builds the
allow-list, the safety flags, and the shared `artifacta.Client`, then runs
the MCP stdio server.

Argv parsing is intentionally hand-rolled (no argparse) so that we can
preserve the exact `--allow-path=PATH` and `--allow-path PATH` syntaxes the
TypeScript `buildAllowList` recognises — the path-confinement port consumes
the same shape.
"""
from __future__ import annotations

import asyncio
import os
import sys

from artifacta import Client

from . import __version__, allowlist, client_factory, path_confinement
from .safety import clear_registry, parse_safety_flags
from .tools import register_all_tools


def _print_version() -> int:
    print(__version__)
    return 0


def _print_help() -> int:
    sys.stdout.write(
        f"""artifacta-mcp {__version__}

Usage: artifacta-mcp [options]

Options:
  --version                Print version and exit.
  -h, --help               Print this message and exit.
  --allow-destructive      Expose destructive tools (delete_artifact,
                           seal_session, create_download_link) to clients
                           that do NOT advertise experimental.confirmations.
                           For compliant clients this flag has no effect — those
                           clients always get the tools with requiresConfirmation
                           set in tools/list.
  --allow-path=PATH        Add PATH (absolute) to the path-confinement
                           allow-list. May be specified multiple times or
                           passed as `--allow-path PATH`. Colon-separated
                           values are accepted.

Environment:
  ARTIFACTA_API_KEY                       Required. Bearer key (ak_live_…).
  ARTIFACTA_API_URL                       Override API base URL (default: production).
  ARTIFACTA_MCP_ALLOW_PATH                Colon-separated additional allow-list paths.
  ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM=1   For compliant clients, promote
                                          store_artifact / request_upload_url /
                                          complete_upload / create_download_link
                                          to requiresConfirmation.

Docs: https://docs.artifacta.io/mcp
"""
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    """Entry point — used by the `artifacta-mcp` console script."""
    args = list(sys.argv[1:]) if argv is None else list(argv)

    if "--version" in args:
        return _print_version()
    if "-h" in args or "--help" in args:
        return _print_help()

    # Build the path-confinement allow-list (CWD + --allow-path + env var).
    # Exits with code 2 if any --allow-path entry is relative.
    roots = path_confinement.build_allow_list(args)
    allowlist.set_allow_roots(roots)
    path_confinement.log_allow_list(roots)

    flags = parse_safety_flags(args)

    # Build the shared artifacta SDK Client — single HTTP client per plan §8.1.
    api_key = os.environ.get("ARTIFACTA_API_KEY")
    api_url = os.environ.get("ARTIFACTA_API_URL")
    if not api_key:
        sys.stderr.write(
            "[artifacta-mcp] refusing to start: ARTIFACTA_API_KEY is not set. "
            "Obtain a key at https://app.artifacta.io/dashboard/keys.\n"
        )
        return 2

    # Defence-in-depth against the pyproject.toml dependency floor being
    # bypassed (vendor override, monorepo pip install -e, downgrade resolver
    # edge cases). Verify the imported Client actually has the surface we
    # depend on before any tool runs. The dependency floor is the primary
    # contract; this check turns a confusing first-call AttributeError /
    # TypeError into a clear launch-time error with an upgrade hint.
    from .sdk_compat import check_sdk_compatibility

    compat_error = check_sdk_compatibility(Client)
    if compat_error is not None:
        sys.stderr.write(compat_error + "\n")
        return 2

    client = Client(api_key=api_key, base_url=api_url)
    client_factory.set_client(client)

    # Register tools (idempotent — clears + re-registers so a re-invoked main
    # picks up a clean registry).
    clear_registry()
    register_all_tools()

    sys.stderr.write(
        f"[artifacta-mcp] {__version__} ready — {len(allowlist.get_allow_roots())} allow-list root(s), "
        f"--allow-destructive={flags.allow_destructive}, "
        f"ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM={'1' if flags.write_confirm_required else '0'}\n"
    )

    # Local import — server.py pulls the heavy `mcp` SDK.
    from .server import serve_stdio

    try:
        asyncio.run(serve_stdio(flags.allow_destructive, flags.write_confirm_required))
    except (KeyboardInterrupt, BrokenPipeError):
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
