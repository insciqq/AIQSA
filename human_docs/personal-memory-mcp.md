# Personal Memory through MCP

A compatible external MCP client can access the same Personal Memory facts as the AIQSA Memory UI. Use the installation's public URL with `/mcp`, for example `https://aiqsa.example/mcp`. This is separate from the MCP servers that AIQSA calls from its chats.

## Connect a client

Add the endpoint in your MCP client and complete its browser authentication flow. The consent page identifies the client and the fact access it requests.

```bash
# Claude Code: after adding the server, run /mcp to complete authentication
claude mcp add --transport http aiqsa-memory https://aiqsa.example/mcp

# Codex CLI
codex mcp add aiqsa-memory --url https://aiqsa.example/mcp
codex mcp login aiqsa-memory
```

For protocol inspection, [MCP Inspector](https://github.com/modelcontextprotocol/inspector) can connect to the same URL using Streamable HTTP and OAuth. Client-specific instructions are available in the [Claude Code](https://code.claude.com/docs/en/mcp) and [Codex](https://developers.openai.com/codex/mcp/) documentation.

## Access and revocation

The client can use `add_memory`, `search_memories`, `list_memories`, `get_memory`, `update_memory`, and `delete_memory`. Access covers facts, not chat history. AIQSA does not generate answers for these calls; the external client's model chooses when to use the tools. Semantic search may use the installation's configured embedding and reranking services.

Review or revoke a client in **Settings → Connected apps**. Revocation stops future calls from that client and preserves the stored facts.
