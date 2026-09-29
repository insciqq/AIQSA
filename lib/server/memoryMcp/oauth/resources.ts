/** Immutable resource/capability pairs; each resource requires its own consent. */
export const INBOUND_MCP_MEMORY_CAPABILITY = "memory:facts";
export const INBOUND_MCP_HUB_CAPABILITY = "mcp:hub";
export const INBOUND_MCP_SKILLS_CAPABILITY = "skills:store";
export type InboundMcpCapability = "memory:facts" | "mcp:hub" | "skills:store";
export type InboundMcpResourcePath = "/mcp" | "/mcp/hub" | "/mcp/skills";
export type InboundMcpAuthority = Readonly<{
  capability: InboundMcpCapability;
  resource: string;
  resourcePath: InboundMcpResourcePath;
}>;

export function inboundMcpResourceUrl(issuer: string, resourcePath: InboundMcpResourcePath): string {
  return new URL(resourcePath, issuer).toString();
}

export function inboundMcpResourceAuthority(
  issuer: string,
  resource: string
): InboundMcpAuthority | null {
  for (const resourcePath of ["/mcp", "/mcp/hub", "/mcp/skills"] as const) {
    if (resource === inboundMcpResourceUrl(issuer, resourcePath)) {
      return {
        capability: resourcePath === "/mcp" ? INBOUND_MCP_MEMORY_CAPABILITY
          : resourcePath === "/mcp/hub" ? INBOUND_MCP_HUB_CAPABILITY : INBOUND_MCP_SKILLS_CAPABILITY,
        resource,
        resourcePath
      };
    }
  }
  return null;
}

export function inboundMcpProtectedResourceMetadataUrl(
  issuer: string,
  resourcePath: InboundMcpResourcePath
): string {
  return new URL(`/.well-known/oauth-protected-resource${resourcePath}`, issuer).toString();
}
