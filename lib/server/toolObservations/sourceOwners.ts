import type { Prisma, ToolObservation } from "@prisma/client";
import { loadEntitlementsForUser } from "../auth/dbEntitlements";
import { canAccessSearchStrategy } from "../auth/entitlements";
import { assertMcpToolAccess } from "../mcp/toolAccess";
import { namespacedMcpToolName } from "../mcp/runPlan";
import { createSkillCatalogRepository } from "../skills/catalogRepository";
import { decodeFrozenSkillManifest } from "../skills/runManifest";
import { parsePersistedToolExecutionResult } from "../runs/toolExecutionPersistence";
import { snapshotToolLoopJson, toolLoopPersistenceLimits } from "../runs/toolLoopPersistence";
import { isSkillToolName } from "../tools/skill";
import { decodeToolObservationSourceBinding, ObservationStoreError } from "./contract";
import type { ObservationActor } from "./repository";

type SourceOwner = Readonly<{
  authorize(tx: Prisma.TransactionClient, source: ToolObservation, actor: ObservationActor): Promise<void>;
  load(tx: Prisma.TransactionClient, source: ToolObservation, actor: ObservationActor): Promise<unknown>;
}>;
const unavailable = () => new ObservationStoreError("tool_observation_unavailable");
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** No runtime/discovery/provider calls: recall rechecks the live resource
 * permissions while retaining the accepted source identity. */
export function createObservationSourceOwners(knowledge: SourceOwner) {
  return {
    async authorizeSource(tx: Prisma.TransactionClient, source: ToolObservation, actor: ObservationActor) {
      const run = await tx.modelRun.findUnique({ where: { id: source.modelRunId },
        select: { chat: { select: { projectId: true } } } });
      if (!run) throw unavailable();
      const projectId = run.chat.projectId;
      // The durable parent owns accepted Workspace bytes. Reset, expiration or
      // turning Workspace off cannot grant a reread of the mutable guest path.
      if (source.sourceKind === "workspace") return;
      if (source.sourceKind === "knowledge") return knowledge.authorize(tx, source, actor);
      const binding = decodeToolObservationSourceBinding(source.sourceBinding, source.sourceKind);
      if (!binding) throw unavailable();
      if (binding.source === "mcp") {
        const call = await tx.modelRunToolCall.findUnique({ where: { id: source.toolCallId }, select: {
          toolName: true,
          mcpRunBinding: { select: { modelRunId: true, runtimeGenerationFingerprint: true,
            runtimeGeneration: { select: { revisionId: true, revision: { select: { serverId: true } } } } } }
        } });
        const accepted = call?.mcpRunBinding;
        if (!accepted || accepted.modelRunId !== source.modelRunId || accepted.runtimeGenerationFingerprint !== binding.fingerprint ||
          accepted.runtimeGeneration && (accepted.runtimeGeneration.revisionId !== binding.revisionId ||
            accepted.runtimeGeneration.revision.serverId !== binding.serverId) ||
          !accepted.runtimeGeneration && source.state !== "READY") throw unavailable();
        const memberships = await tx.userGroup.findMany({ where: { userId: actor.userId, group: { archivedAt: null } }, select: { groupId: true } });
        const server = await tx.mcpServer.findFirst({ where: { id: binding.serverId, enabled: true, archivedAt: null,
          ...(projectId ? { projectBindings: { some: { projectId } } } : {
            grants: { some: { canUse: true, OR: [{ userId: actor.userId }, { groupId: { in: memberships.map(group => group.groupId) } }] } },
            userServers: { some: { userId: actor.userId, enabled: true } }
          }) }, select: { namespace: true, activeRevision: { select: { configuration: true } } } });
        if (!server?.activeRevision || call?.toolName !== namespacedMcpToolName(server.namespace, binding.originalName)) throw unavailable();
        const config = server.activeRevision.configuration;
        if (record(config) && Array.isArray(config.disabledToolNames) && config.disabledToolNames.includes(binding.originalName)) throw unavailable();
        await assertMcpToolAccess(tx, actor.userId, [{ serverId: binding.serverId, originalName: binding.originalName }]);
        return;
      }
      if (binding.source === "skill") {
        const [accepted] = await tx.$queryRaw<Array<{ skills: unknown }>>`
          SELECT "normalizedRequest"->'skills' AS skills FROM "ModelRun" WHERE "id" = ${source.modelRunId}`;
        const manifest = decodeFrozenSkillManifest(accepted?.skills);
        const call = await tx.modelRunToolCall.findUnique({ where: { id: source.toolCallId },
          select: { toolName: true, arguments: true } });
        if (!call || !isSkillToolName(call.toolName) || !record(call.arguments) || !manifest ||
          ![...manifest.pinned, ...manifest.available].some(item => item.alias === (call.arguments as Record<string, unknown>).skill &&
          item.skillId === binding.skillId && item.revisionId === binding.revisionId) ||
          !await createSkillCatalogRepository(tx).resolveFrozen({ userId: actor.userId, ...(projectId ? { projectId } : {}),
            skillId: binding.skillId, revisionId: binding.revisionId })) throw unavailable();
        return;
      }
      const [accepted] = await tx.$queryRaw<Array<{ options: unknown }>>`
        SELECT "normalizedRequest"->'searchPlan'->'options' AS options FROM "ModelRun" WHERE "id" = ${source.modelRunId}`;
      if (!Array.isArray(accepted?.options)) throw unavailable();
      const entitlements = projectId ? null : await loadEntitlementsForUser(actor.userId, tx);
      for (const item of binding.sources) {
        if (!accepted.options.some(option => record(option) && option.optionId === item.optionId && option.revisionId === item.revisionId)) throw unavailable();
        const revision = await tx.searchIntegrationRevision.findFirst({ where: { id: item.revisionId,
          searchStrategy: { enabled: true, archivedAt: null, searchOption: { optionId: item.optionId, enabled: true, archivedAt: null,
            ...(projectId ? { projectBindings: { some: { projectId } } } : {}) } } }, select: { id: true } });
        if (!revision || entitlements && !canAccessSearchStrategy(entitlements, item.optionId)) throw unavailable();
      }
    },

    async loadSource(tx: Prisma.TransactionClient, source: ToolObservation, actor: ObservationActor): Promise<unknown> {
      if (source.sourceKind === "knowledge") return knowledge.load(tx, source, actor);
      if (source.sourceKind !== "skill") throw unavailable();
      const call = await tx.modelRunToolCall.findUnique({ where: { id: source.toolCallId },
        select: { providerCallId: true, toolName: true, result: true, state: true } });
      if (!call || !["complete", "error"].includes(call.state)) throw unavailable();
      const result = parsePersistedToolExecutionResult({ id: call.providerCallId, name: call.toolName },
        snapshotToolLoopJson(call.result, toolLoopPersistenceLimits.resultBytes));
      if (!result) throw unavailable();
      // Instructions keep their existing admitted result owner and are never
      // maskable. Do not hash a new descriptor recursively into its original.
      const original = { ...result };
      delete original.observation;
      return original;
    }
  };
}
