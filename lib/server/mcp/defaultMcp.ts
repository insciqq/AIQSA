import { prisma } from "@/lib/server/prisma";
import { mcpOAuthService } from "./defaultOAuth";
import type { McpDraftValidator } from "./draftValidator";
import { createPrismaMcpRepository } from "./prismaRepository";
import { personalMcpAddressPolicy } from "./defaultPersonalNetwork";
import { mcpDestinationSafeFetchOptions } from "./personalNetworkPolicy";
import { createRemoteMcpDraftValidator } from "./remoteDraftValidator";
import { createMcpSafeFetch, type McpAddressPolicy } from "./safeFetch";

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

/**
 * The installation's draft validator. A personal draft (`personal: true`)
 * validates under the personal network policy; an installation draft keeps
 * its reviewed per-server permission. The policy is injectable for tests.
 */
export function createDefaultMcpDraftValidator(input: Readonly<{
  personalAddressPolicy?: McpAddressPolicy;
}> = {}): McpDraftValidator {
  const personalAddressPolicy = input.personalAddressPolicy ?? personalMcpAddressPolicy;
  return createRemoteMcpDraftValidator({
    fetch: createMcpSafeFetch(),
    fetchForDraft: (draft, { personal }) => createMcpSafeFetch(mcpDestinationSafeFetchOptions({
      allowInsecureHttp: true,
      allowPrivateNetwork: draft.source.allowPrivateNetwork === true,
      personal
    }, personalAddressPolicy)),
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
}

export const defaultMcpDraftValidator = createDefaultMcpDraftValidator();

export const mcpRepository = createDefaultMcpRepository({
  draftValidator: defaultMcpDraftValidator
});
