import { createPrismaMcpOAuthRepository } from "./oauthRepository";
import { McpOAuthService } from "./oauthService";

export const mcpOAuthRepository = createPrismaMcpOAuthRepository();
export const mcpOAuthService = new McpOAuthService({ repository: mcpOAuthRepository });

export function createDefaultMcpOAuthRuntimeProvider(connectionId: string) {
  return mcpOAuthService.createRuntimeProvider(connectionId);
}
