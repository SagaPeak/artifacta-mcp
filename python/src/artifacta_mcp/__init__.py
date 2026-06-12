"""Artifacta MCP server — Python port of @artifacta-mcp/mcp."""

# Public helper for the framework-integration wrappers (OpenAI Agents SDK,
# LangChain, the CrewAI recipe): build the stdio launch params for the
# artifacta-mcp server. Re-exported here so users import from the package root
# rather than the private `_integration_common` module. Dependency-free
# (stdlib only), so this is safe at package load.
from ._integration_common import ARTIFACTA_MCP_COMMAND, build_stdio_params

__version__ = "1.0.2"

__all__ = ["__version__", "ARTIFACTA_MCP_COMMAND", "build_stdio_params"]
