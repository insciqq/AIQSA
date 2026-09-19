import { Prisma, type PrismaClient } from "@prisma/client";
import { DEFAULT_DECISION_FEATURES, JEV_MODEL_ID, JEV_SERVED_MODEL_ID,
  decisionFeatureEnabled, jevModelConfiguration } from "../../domain/decisionModels";
import { createAdminProviderCredentialTester } from "../admin/providers/credentialTester";
import { createPrismaAdminProviderRepository } from "../admin/providers/prismaRepository";
import { createAdminProviderService } from "../admin/providers/service";
import { createAdminProviderDraftTester, type AdminProviderDraftTester } from "../admin/providers/tester";
import { loadInstallationDecisionProviderRole, ProviderAdmissionError } from "../providerRuntime/admission";
import { logEvent } from "../observability";

type AdoptionResult = "applied" | "preserved" | "unavailable" | "verification_required" | "already_attempted";
const claimedPolicy = { id: "installation", decisionAdoptionVersion: 1, decisionAdoptionReason: "verification_required" };
const unconfiguredRole = { decisionProviderModelId: null, decisionConfiguredAt: null };

/** One bounded startup upgrade, independent of core readiness. Its durable
 * claim precedes model creation and paid I/O. Failed or crash-ambiguous checks
 * remain repairable through ordinary Providers Test & Save, never replayed by
 * restarting the application. Existing configured models remain operator-owned. */
export async function adoptDecisionModelOnUpgrade(input: Readonly<{
  db: PrismaClient;
  tester?: AdminProviderDraftTester;
  encryptionKey?: () => Buffer;
  signal?: AbortSignal;
}>): Promise<AdoptionResult> {
  const { db, signal } = input;
  const claimed = await db.systemModelPolicy.updateMany({
    where: { id: "installation", decisionAdoptionVersion: 0 },
    data: { decisionAdoptionVersion: 1, decisionAdoptionReason: "verification_required" }
  });
  if (claimed.count !== 1) return "already_attempted";

  async function finish(reason: string, result: AdoptionResult): Promise<AdoptionResult> {
    await db.systemModelPolicy.updateMany({ where: claimedPolicy, data: { decisionAdoptionReason: reason } });
    if (result === "verification_required") logEvent("service_operation", {
      subsystem: "admin", stage: "startup", outcome: "degraded", code: "decision_model_adoption_failed"
    });
    return result;
  }
  try {
    signal?.throwIfAborted();
    const policy = await db.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
    if (policy.decisionProviderModelId || policy.decisionConfiguredAt ||
      !DEFAULT_DECISION_FEATURES.some(feature => decisionFeatureEnabled(policy.decisionFeaturesJson, feature))) {
      return finish("preserved", "preserved");
    }
    const connections = await db.providerConnection.findMany({
      where: { family: "openrouter", enabled: true, activeVersion: { gt: 0 }, defaultCredentialId: { not: null } },
      include: { defaultCredential: { include: { activeVersion: true } }, models: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }]
    });
    const eligible = connections.filter(connection => connection.activeConfig &&
      connection.activeVersion === connection.draftVersion && !connection.catalogSkippedIds.includes(JEV_MODEL_ID) &&
      connection.defaultCredential?.enabled && connection.defaultCredential.activeVersion?.secretEnvelope &&
      !connection.defaultCredential.activeVersion.revokedAt);

    // Reuse an already checked deployment without touching its draft or paying
    // again. An existing disabled, edited or unverified model is not auto-repaired.
    async function qualified(db: Prisma.TransactionClient | PrismaClient, modelId: string) {
      try {
        const role = await loadInstallationDecisionProviderRole(db, { providerModelId: modelId });
        return role.configuration.upstreamModelId === JEV_MODEL_ID &&
          role.snapshot.decisionVerification?.servedModelId === JEV_SERVED_MODEL_ID &&
          role.snapshot.decisionVerification.provider.toLowerCase() === "typesafe";
      } catch (error) {
        if (error instanceof ProviderAdmissionError) return false;
        throw error;
      }
    }
    async function assign(modelId: string, assertAuthority?: (tx: Prisma.TransactionClient) => Promise<void>): Promise<boolean> {
      return db.$transaction(async tx => {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SystemModelPolicy" WHERE id = 'installation' FOR UPDATE`);
        const current = await tx.systemModelPolicy.findUnique({ where: { id: "installation" } });
        if (!current || current.decisionProviderModelId || current.decisionConfiguredAt ||
          current.decisionAdoptionReason !== "verification_required" ||
          !DEFAULT_DECISION_FEATURES.some(feature => decisionFeatureEnabled(current.decisionFeaturesJson, feature))) return false;
        await assertAuthority?.(tx);
        if (!await qualified(tx, modelId)) throw new Error("decision_adoption_model_unqualified");
        signal?.throwIfAborted();
        await tx.systemModelPolicy.update({ where: { id: "installation" }, data: {
          decisionProviderModelId: modelId, decisionConfiguredAt: new Date(),
          decisionAdoptionReason: "applied", version: { increment: 1 }, updatedByUserId: null
        } });
        return true;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });
    }
    for (const connection of eligible) {
      for (const model of connection.models) {
        if (model.modelId !== JEV_MODEL_ID || !model.enabled || !model.activeVersion || model.draftVersion !== model.activeVersion) continue;
        if (await qualified(db, model.id)) {
          const published = await assign(model.id, async tx => {
            if (!await tx.providerModel.findFirst({ where: {
              id: model.id, enabled: true, activeVersion: model.activeVersion, draftVersion: model.draftVersion,
              connection: { enabled: true, activeVersion: connection.activeVersion, draftVersion: connection.draftVersion,
                defaultCredentialId: connection.defaultCredentialId,
                NOT: { catalogSkippedIds: { has: JEV_MODEL_ID } },
                defaultCredential: { enabled: true, activeVersionId: connection.defaultCredential!.activeVersionId,
                  activeVersion: { revokedAt: null } } }
            }, select: { id: true } })) throw new Error("decision_adoption_authority_changed");
          });
          return published ? "applied" : finish("authority_changed", "preserved");
        }
      }
    }
    const connection = eligible.find(entry => !entry.models.some(model => model.modelId === JEV_MODEL_ID));
    if (!connection) return finish(eligible.length ? "preserved_model" : "no_openrouter", eligible.length ? "preserved" : "unavailable");
    const credential = connection.defaultCredential!;
    const credentialVersion = credential.activeVersion!;
    let modelId: string | null = null;

    // Recheck the exact upgrade destination before every physical probe and
    // before final assignment, including default-key changes during verification.
    async function assertAuthority(client: Prisma.TransactionClient | PrismaClient = db): Promise<void> {
      signal?.throwIfAborted();
      const current = await client.systemModelPolicy.findFirst({
        where: { ...claimedPolicy, ...unconfiguredRole }, select: { decisionFeaturesJson: true }
      });
      if (!current || !DEFAULT_DECISION_FEATURES.some(feature => decisionFeatureEnabled(current.decisionFeaturesJson, feature))) {
        throw new Error("decision_adoption_authority_changed");
      }
      const currentConnection = await client.providerConnection.findFirst({ where: {
        id: connection!.id, family: "openrouter", enabled: true,
        activeVersion: connection!.activeVersion, draftVersion: connection!.draftVersion, defaultCredentialId: credential.id,
        NOT: { catalogSkippedIds: { has: JEV_MODEL_ID } },
        defaultCredential: { enabled: true, activeVersionId: credentialVersion.id, activeVersion: { revokedAt: null } }
      }, select: { id: true } });
      if (!currentConnection) throw new Error("decision_adoption_authority_changed");
      if (modelId && !await client.providerModel.findFirst({ where: {
        id: modelId, connectionId: connection!.id, enabled: true, draftVersion: 1, activeVersion: { in: [0, 1] }
      }, select: { id: true } })) throw new Error("decision_adoption_authority_changed");
    }
    const tester = input.tester ?? createAdminProviderDraftTester();
    const providers = createAdminProviderService({
      repository: createPrismaAdminProviderRepository(db),
      credentialTester: createAdminProviderCredentialTester(), encryptionKey: input.encryptionKey,
      tester: { async test(request) {
        await assertAuthority();
        if (request.connectionId !== connection.id || request.credentialId !== credential.id ||
          request.credentialVersionIdentity !== credentialVersion.id || request.providerModelId !== modelId ||
          typeof request.secret !== "function") throw new Error("decision_adoption_authority_changed");
        const secret = request.secret;
        return tester.test({ ...request, secret: async () => { await assertAuthority(); return secret(); } });
      } }
    });
    await assertAuthority();
    const draft = await providers.createModelDraft({ connectionId: connection.id, displayName: "Jev 1.13", configuration: jevModelConfiguration() });
    modelId = draft.id;
    await assertAuthority();
    const result = await providers.activateModel({ connectionId: connection.id, modelId, expectedDraftVersion: draft.draftVersion, signal });
    if (result.check !== "checked") return finish("check_failed", "verification_required");
    if (!await assign(modelId, assertAuthority)) return finish("authority_changed", "preserved");
    return "applied";
  } catch {
    return finish("verification_required", "verification_required");
  }
}

let running: Promise<unknown> | undefined;
export function startDecisionModelAdoption(): void {
  running ??= import("../prisma").then(({ prisma }) => adoptDecisionModelOnUpgrade({ db: prisma })).catch(() => {
    logEvent("service_operation", { subsystem: "admin", stage: "startup", outcome: "degraded", code: "decision_model_adoption_failed" });
  });
}
