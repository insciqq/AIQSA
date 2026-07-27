import type { McpRepository } from "./repositoryContract";
import type { McpOAuthPurpose } from "./oauthPolicy";

export type McpOAuthSettlementInput = Readonly<{
  configurationIdentity: string;
  purpose: McpOAuthPurpose;
  serverId: string;
  userId: string;
}>;

export type McpOAuthSettlementResult = Readonly<
  | { kind: "failed" }
  | { kind: "ok" }
>;

export type McpOAuthSettler = (
  input: McpOAuthSettlementInput
) => Promise<McpOAuthSettlementResult>;

export function createMcpOAuthSettler(
  repository: McpRepository,
  onActivationRequested?: () => void
): McpOAuthSettler {
  return async (input) => {
    if (input.purpose === "user") {
      const updated = await repository.updateUserServer({
        enabled: true,
        serverId: input.serverId,
        userId: input.userId
      });
      return updated.kind === "ok" && updated.value.enabled
        ? { kind: "ok" }
        : { kind: "failed" };
    }

    const queued = await repository.requestActivation({
      expectedDraftHash: input.configurationIdentity,
      serverId: input.serverId,
      validationUserId: input.userId
    });
    if (queued.kind !== "ok" || queued.value.activation?.stage === "failed") {
      return { kind: "failed" };
    }
    try {
      onActivationRequested?.();
    } catch {
      // The durable queue is authoritative; the periodic scheduler will recover a missed kick.
    }
    return { kind: "ok" };
  };
}
