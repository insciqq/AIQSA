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

export function createMcpOAuthSettler(repository: McpRepository): McpOAuthSettler {
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

    const tested = await repository.testDraft({
      expectedDraftHash: input.configurationIdentity,
      oneTimeValues: {},
      serverId: input.serverId,
      validationUserId: input.userId
    });
    if (tested.kind !== "ok" ||
      tested.value.draftTest?.draftHash !== input.configurationIdentity ||
      !tested.value.draftTested) {
      return { kind: "failed" };
    }

    const activated = await repository.activateDraft(input.serverId);
    if (activated.kind !== "ok" || !activated.value.enabled ||
      activated.value.activeRevision?.draftHash !== input.configurationIdentity) {
      return { kind: "failed" };
    }
    return { kind: "ok" };
  };
}
