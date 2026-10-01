import { createPrismaMcpOAuthRepository } from "./oauthRepository";
import { McpOAuthService } from "./oauthService";
import { getAuthConfig } from "@/lib/server/auth/config";

export const mcpOAuthRepository = createPrismaMcpOAuthRepository();
export const mcpOAuthService = new McpOAuthService({
  connectorClients: () => getAuthConfig().mcpConnectorOAuth,
  repository: mcpOAuthRepository
});

export function createDefaultMcpOAuthRuntimeProvider(connectionId: string) {
  return mcpOAuthService.createRuntimeProvider(connectionId);
}
