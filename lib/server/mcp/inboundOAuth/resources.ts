/**
 * Immutable resource/capability pairs; each resource requires its own consent. The retired Personal Memory
 * resource (`/mcp`, capability `memory:facts`) is no longer one of them, so its grants and tokens resolve to
 * nothing and are refused like unknown ones (operator decision 2026-11-22).
 */
export const INBOUND_MCP_HUB_CAPABILITY = "mcp:hub";
export const INBOUND_MCP_SKILLS_CAPABILITY = "skills:store";
export const INBOUND_MCP_RESOURCE_PATHS = ["/mcp/hub", "/mcp/skills"] as const;
export type InboundMcpCapability = "mcp:hub" | "skills:store";
export type InboundMcpResourcePath = (typeof INBOUND_MCP_RESOURCE_PATHS)[number];
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
  for (const resourcePath of INBOUND_MCP_RESOURCE_PATHS) {
    if (resource === inboundMcpResourceUrl(issuer, resourcePath)) {
      return {
        capability: resourcePath === "/mcp/hub" ? INBOUND_MCP_HUB_CAPABILITY : INBOUND_MCP_SKILLS_CAPABILITY,
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
