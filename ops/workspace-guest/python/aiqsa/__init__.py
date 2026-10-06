"""AIQSA Workspace guest helpers. Standard library only.

``aiqsa.mcp`` calls the current run's MCP tools from code; the ``aiqsa-mcp``
command does the same for any language.
"""

from . import errors, mcp
from .errors import AiqsaMcpError

__version__ = "1.0.0"
__all__ = ["AiqsaMcpError", "__version__", "errors", "mcp"]
