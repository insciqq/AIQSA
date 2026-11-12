import type { PrismaClient } from "@prisma/client";
import { resolveProviderCredential } from "../../../domain/providerCredentialResolution";
import { isAssistantAvailable } from "../../assistants/bindingAccess";
import { assistantRowCatalogFailures, type AssistantRowCatalogFailures } from "../../assistants/catalogValidation";
import { loadAssistantCatalogView } from "../../assistants/handlers";
import { assistantRowsFromStoredColumns } from "../../assistants/storedContent";
import { findServiceAccount } from "../../auth/serviceAccounts";
import type { CatalogData } from "../../catalog/currentUserCatalog";
import type { DiscordAssistantSetupFacts, DiscordSetupSources } from "./setup";

/**
 * The setup check's database reads, through the owners the product already
 * has: Assistant availability (`bindingAccess`), the Assistant's rows checked
 * against the service account's own catalog exactly as the Assistant editor
 * checks a runner (`catalogValidation`), the provider key resolution order
 * (user, then group, then the connection's default) and the usage limits.
 */

type AssistantCatalogDeps = Parameters<typeof loadAssistantCatalogView>[0];

export function createPrismaDiscordSetupSources(deps: Readonly<{
  prisma: PrismaClient;
  loadCatalogData(userId: string): Promise<CatalogData | null>;
  assistantRepository: AssistantCatalogDeps["repository"];
  /** The effective monthly budget of a user (own override, groups, installation default). */
  monthlyBudgetMicros(userId: string): Promise<number | null>;
}>): DiscordSetupSources {
  const { prisma } = deps;

  async function credentialSource(userId: string, providerModelId: string): Promise<"own" | "shared" | "unavailable"> {
    const model = await prisma.providerModel.findUnique({
      select: { connection: { select: { defaultCredentialId: true, id: true, unassignedPolicy: true } } },
      where: { id: providerModelId }
    });
    if (!model) return "unavailable";
    const connectionId = model.connection.id;
    const [credentials, memberships, direct] = await Promise.all([
      prisma.providerCredential.findMany({
        select: { activeVersion: { select: { id: true, revokedAt: true } }, enabled: true, id: true },
        where: { connectionId }
      }),
      prisma.userGroup.findMany({ select: { group: { select: { archivedAt: true } }, groupId: true }, where: { userId } }),
      prisma.providerUserCredentialAssignment.findUnique({
        select: { credentialId: true }, where: { connectionId_userId: { connectionId, userId } }
      })
    ]);
    const groupIds = memberships.filter((membership) => !membership.group.archivedAt).map((membership) => membership.groupId);
    const assignments = groupIds.length > 0
      ? await prisma.providerGroupCredentialAssignment.findMany({
        select: { credentialId: true, groupId: true }, where: { connectionId, groupId: { in: groupIds } }
      })
      : [];
    const resolution = resolveProviderCredential({
      assignments,
      credentials: credentials.map((credential) => ({
        activeVersion: credential.activeVersion
          ? { id: credential.activeVersion.id, revoked: credential.activeVersion.revokedAt !== null }
          : null,
        enabled: credential.enabled,
        id: credential.id
      })),
      defaultCredentialId: model.connection.defaultCredentialId,
      directAssignmentCredentialId: direct?.credentialId ?? null,
      memberships: groupIds.map((groupId) => ({ archived: false, groupId })),
      policy: model.connection.unassignedPolicy
    });
    if (!resolution.ok) return "unavailable";
    return resolution.source === "default" ? "shared" : "own";
  }

  return Object.freeze({
    async serviceAccount(userId) {
      const account = await findServiceAccount(prisma, userId);
      return account ? { status: account.status } : null;
    },

    async assistant({ assistantId, serviceUserId }): Promise<DiscordAssistantSetupFacts> {
      if (!await isAssistantAvailable(prisma, { assistantId, scope: { kind: "personal", userId: serviceUserId } })) {
        return { state: "unavailable" };
      }
      const definition = await prisma.assistantDefinition.findUnique({
        select: {
          controlsPolicy: true, mcpMode: true, mcpServerIds: true, modelPolicy: true, providerModelId: true, runControls: true,
          searchPlan: true, searchPolicy: true, skillLinks: { orderBy: { ordinal: "asc" }, select: { mode: true, skillId: true } },
          skillsMode: true, skillsPolicy: true, toolsPolicy: true
        },
        where: { id: assistantId }
      });
      const rows = definition ? assistantRowsFromStoredColumns(definition) : null;
      if (!rows) return { state: "unavailable" };
      const view = await loadAssistantCatalogView({ loadCatalogData: deps.loadCatalogData, repository: deps.assistantRepository }, serviceUserId);
      const modelValue = rows.model.value;
      const searchValue = rows.search.value;
      const toolsValue = rows.tools.value;
      const failures: AssistantRowCatalogFailures = view
        ? assistantRowCatalogFailures({ controls: rows.controls.value, model: modelValue, search: searchValue, tools: toolsValue }, view,
          { mcpRunnability: "startable" })
        : { model: true, search: true, tools: true };
      const model = modelValue.mode !== "model" || modelValue.modelId === null
        ? "inherit"
        : failures.model || failures.controls ? "unavailable" : "ok";
      const credential = model === "ok" && modelValue.mode === "model" && modelValue.modelId !== null
        ? await credentialSource(serviceUserId, modelValue.modelId)
        : null;
      // Search inherited from the installation is on: Search is on for everyone.
      const search = searchValue.mode === "off" ? "off" : failures.search ? "unusable" : "on";
      const mcp = toolsValue.mode !== "exact" || toolsValue.serverIds.length === 0 ? "none" : failures.tools ? "not_granted" : "granted";
      return { credential, mcp, model, search, state: "available" };
    },

    async monthlyBudget(serviceUserId) {
      return await deps.monthlyBudgetMicros(serviceUserId) !== null;
    }
  });
}

/** The Assistant's MCP servers the service account must have switched on for runs to start them. */
export async function discordAssistantMcpServerIds(prisma: Pick<PrismaClient, "assistantDefinition">, assistantId: string): Promise<string[]> {
  const definition = await prisma.assistantDefinition.findUnique({ select: { mcpMode: true, mcpServerIds: true }, where: { id: assistantId } });
  return definition?.mcpMode === "exact" ? [...definition.mcpServerIds] : [];
}
