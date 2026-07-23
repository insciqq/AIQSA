import { prisma } from "@/lib/server/prisma";
import { createMcpClientSessionFactory } from "./clientSessionFactory";
import { mcpOAuthService } from "./defaultOAuth";
import { getDefaultToolHiveClient, getDefaultToolHiveDriver } from "./defaultToolHive";
import type { McpDraftValidator } from "./draftValidator";
import { createLocalMcpDraftValidator } from "./localDraftValidator";
import { createMcpOAuthSettler } from "./oauthSettlement";
import { createPrismaMcpRepository } from "./prismaRepository";
import { createRemoteMcpDraftValidator } from "./remoteDraftValidator";
import { createMcpSafeFetch } from "./safeFetch";
import { createToolHiveMcpSessionFactory } from "./toolhiveSessionFactory";

const VALIDATION_RUNTIME_LIMITS = {
  maxListPages: 16,
  maxToolArgumentBytes: 64 * 1_024,
  maxToolMetadataBytes: 256 * 1_024,
  maxToolResultBytes: 512 * 1_024,
  maxToolSchemaBytes: 64 * 1_024,
  maxTools: 256
} as const;

export function createDefaultMcpRepository(input: { draftValidator?: McpDraftValidator } = {}) {
  return createPrismaMcpRepository({
    ...(input.draftValidator ? { draftValidator: input.draftValidator } : {}),
    oauthRedirectUri: (serverId) => new URL(
      `/api/me/mcp/${encodeURIComponent(serverId)}/oauth/callback`,
      process.env.AIQSA_APP_BASE_URL?.trim() || "http://localhost:3000"
    ).toString(),
    oauthValidationRedirectUri: (serverId) => new URL(
      `/api/admin/mcp/${encodeURIComponent(serverId)}/oauth/validation/callback`,
      process.env.AIQSA_APP_BASE_URL?.trim() || "http://localhost:3000"
    ).toString(),
    prisma
  });
}

function createDefaultMcpDraftValidator(): McpDraftValidator {
  const remote = createRemoteMcpDraftValidator({
    fetch: createMcpSafeFetch(),
    fetchForDraft: (draft) => createMcpSafeFetch({
      allowInsecureHttp: process.env.NODE_ENV !== "production",
      allowPrivateNetwork: draft.source.kind === "remote" && draft.source.allowPrivateNetwork === true
    }),
    oauthProviderForDraft: async (validation) => {
      if (!validation.serverId || !validation.validationUserId) return null;
      return mcpOAuthService.createValidationProvider({
        redirectUri: new URL(
          `/api/admin/mcp/${encodeURIComponent(validation.serverId)}/oauth/validation/callback`,
          process.env.AIQSA_APP_BASE_URL?.trim() || "http://localhost:3000"
        ).toString(),
        serverId: validation.serverId,
        userId: validation.validationUserId
      });
    }
  });
  let local: McpDraftValidator | null = null;
  return {
    validate(input) {
      if (input.draft.source.kind === "remote") return remote.validate(input);
      local ??= createLocalMcpDraftValidator({
        client: getDefaultToolHiveClient(),
        driver: getDefaultToolHiveDriver(),
        sessions: createToolHiveMcpSessionFactory({
          directSessions: createMcpClientSessionFactory({
            fetch: createMcpSafeFetch({
              allowInsecureHttp: true,
              allowPrivateNetwork: true
            }),
            limits: VALIDATION_RUNTIME_LIMITS
          }),
          driver: getDefaultToolHiveDriver()
        })
      });
      return local.validate(input);
    }
  };
}

export const mcpRepository = createDefaultMcpRepository({
  draftValidator: createDefaultMcpDraftValidator()
});

export const settleDefaultMcpOAuth = createMcpOAuthSettler(mcpRepository);
