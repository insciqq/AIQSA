import { Prisma, type PrismaClient } from "@prisma/client";
import { isDeepStrictEqual } from "node:util";
import { createPrismaAdminProviderRepository } from "../admin/providers/prismaRepository";
import { createAdminProviderDraftTester, type AdminProviderDraftTester, type AdminProviderDraftTestOutcome } from "../admin/providers/tester";
import { applyNativeRoute, discoverNativeRoute, nativeRouteMissingCapabilities, nativeRoutePreviouslyUnverified } from "../admin/providers/nativeRouting";
import { decodeNativeRouteAdoptionDiagnostic, type NativeRouteAdoptionDiagnostic } from "../../contracts/nativeRoutingAdoption";
import { capabilityFailureAttempt } from "../admin/providers/capabilityProbeFailure";
import { validateEvidence } from "../admin/providers/service";
import { createOpenRouterDiscoveryClient } from "../providers/openRouterDiscovery";
import { normalizeProviderConnectionConfiguration, normalizeProviderModelConfiguration } from "../providers/providerConfiguration";
import { decryptProviderCredentialSecret } from "../providers/credentialSecrets";
import { getSecretEncryptionKey } from "../secrets/envelope";
import { withTimeoutSignal } from "../providers/network";
import { INITIAL_CAPABILITY_BATCH_TIMEOUT_MS } from "../admin/providers/initialCapabilitySetup";
import { logEvent } from "../observability";

const snapshotInclude = { connection: { include: { credentials: { include: { activeVersion: true } } } },
  activeCredentialChecks: true } as const;
type Snapshot = Prisma.ProviderModelGetPayload<{ include: typeof snapshotInclude }>;

function usableCredentials(snapshot: Snapshot) {
  return snapshot.connection.credentials.filter((key) => key.enabled && key.activeVersion &&
    !key.activeVersion.revokedAt && key.activeVersion.secretEnvelope &&
    snapshot.activeCredentialChecks.some((check) => check.credentialVersionId === key.activeVersionId &&
      check.connectionVersion === snapshot.connection.activeVersion && check.modelVersion === snapshot.activeVersion && check.status === "available"))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Network work happens outside transactions. Claim before dispatch: after a
 * crash, keep the serving route and require an explicit Test & Save instead of
 * replaying ambiguous paid probes. All existing usable keys publish together. */
export async function adoptNativeOpenRouterRoutes(input: {
  db: PrismaClient;
  tester?: AdminProviderDraftTester;
  createDiscovery?: typeof createOpenRouterDiscoveryClient;
  encryptionKey?: () => Buffer;
  signal?: AbortSignal;
}): Promise<{ applied: number; preserved: number; unresolved: number }> {
  const { db, signal } = input;
  const repository = createPrismaAdminProviderRepository(db);
  const tester = input.tester ?? createAdminProviderDraftTester();
  const createDiscovery = input.createDiscovery ?? createOpenRouterDiscoveryClient;
  const totals = { applied: 0, preserved: 0, unresolved: 0 };
  const ids = await db.providerModel.findMany({ where: { provider: "openrouter", nativeRoutingAdoptionVersion: 0 },
    select: { id: true }, orderBy: { id: "asc" } });
  for (const { id } of ids) {
    signal?.throwIfAborted();
    const snapshot = await db.providerModel.findUnique({ where: { id }, include: snapshotInclude });
    if (!snapshot || snapshot.nativeRoutingAdoptionVersion !== 0) continue;
    const guard = { id, activeVersion: snapshot.activeVersion, draftVersion: snapshot.draftVersion };
    const claimed = await db.providerModel.updateMany({ where: { ...guard, nativeRoutingAdoptionVersion: 0 },
      data: { nativeRoutingAdoptionVersion: 1, nativeRoutingAdoptionReason: "verification_required" } });
    if (claimed.count !== 1) continue;
    let diagnostic: NativeRouteAdoptionDiagnostic | undefined;
    async function unresolved(reason = "verification_required") {
      const safeDiagnostic = decodeNativeRouteAdoptionDiagnostic(diagnostic);
      await db.providerModel.updateMany({ where: { ...guard, nativeRoutingAdoptionVersion: 1,
        nativeRoutingAdoptionReason: "verification_required" }, data: { nativeRoutingAdoptionReason: reason,
          nativeRoutingAdoptionEvidence: safeDiagnostic ? safeDiagnostic as Prisma.InputJsonValue : Prisma.DbNull } });
      totals.unresolved += 1;
      logEvent("service_operation", { subsystem: "admin",
        stage: safeDiagnostic?.stage === "catalog" ? "discover" : safeDiagnostic?.stage === "publication" ? "publish" : "validate",
        outcome: "degraded", code: `native_route_${safeDiagnostic?.code ?? reason}`,
        ...(safeDiagnostic?.httpStatus ? { httpStatus: safeDiagnostic.httpStatus } : {}) });
    }
    try {
      const model = normalizeProviderModelConfiguration(snapshot.activeConfig ?? snapshot.draftConfig);
      if (model.openRouterRouting?.mode !== "automatic") {
        await db.providerModel.updateMany({ where: { ...guard, nativeRoutingAdoptionReason: "verification_required" },
          data: { nativeRoutingAdoptionReason: "preserved" } });
        totals.preserved += 1;
        continue;
      }
      const connection = normalizeProviderConnectionConfiguration(snapshot.connection.activeConfig);
      diagnostic = { version: 1, stage: "catalog", code: "verification_required", servingMode: "automatic",
        missing: [], previouslyUnverified: [] };
      const keys = usableCredentials(snapshot);
      if (!snapshot.enabled || !snapshot.connection.enabled || snapshot.connection.family !== "openrouter" ||
        snapshot.activeVersion < 1 || snapshot.draftVersion !== snapshot.activeVersion || !keys.length) {
        await unresolved(); continue;
      }
      const proofs: Array<{ credentialId: string; versionId: string; outcome: AdminProviderDraftTestOutcome }> = [];
      let proposed = model;
      let failure: string | null = null;
      for (const key of keys) {
        const candidate = await repository.loadActiveRefreshCandidate({ connectionId: snapshot.connectionId,
          providerModelId: id, credentialId: key.id });
        if (!candidate || candidate.model.version !== snapshot.activeVersion || candidate.model.draftVersion !== snapshot.draftVersion ||
          candidate.connection.version !== snapshot.connection.activeVersion || candidate.credential.versionId !== key.activeVersionId) {
          failure = "verification_required"; break;
        }
        const secret = async () => {
          // Every outbound request revalidates the exact tuple, including edits
          // made while another key's probes were running.
          const current = await db.providerModel.findFirst({ where: { ...guard, enabled: true,
            nativeRoutingAdoptionReason: "verification_required", connection: { enabled: true, activeVersion: snapshot.connection.activeVersion,
              credentials: { some: { id: key.id, enabled: true, activeVersionId: key.activeVersionId } } } }, select: { id: true } });
          if (!current) throw new Error("native_route_authority_changed");
          const value = await repository.withLockedCredential(key.id, key.activeVersionId!, (version) => {
            if (version.revokedAt || !version.secretEnvelope) throw new Error("native_route_credential_unavailable");
            return decryptProviderCredentialSecret({ credentialId: key.id, valueId: version.id,
              envelope: version.secretEnvelope, key: (input.encryptionKey ?? getSecretEncryptionKey)() });
          });
          if (!value) throw new Error("native_route_credential_unavailable");
          return value;
        };
        diagnostic = { ...diagnostic, stage: "catalog", previouslyUnverified: nativeRoutePreviouslyUnverified(model, candidate.priorEvidence) };
        const route = await discoverNativeRoute(createDiscovery({ ...connection, bearerToken: secret }), model, signal, candidate.priorEvidence);
        if (!route.available) { failure = route.reason; diagnostic = route.diagnostic; break; }
        if (proofs.length && proposed.openRouterRouting?.providers[0] !== route.provider) { failure = "native_incompatible"; break; }
        diagnostic = { ...diagnostic, stage: "modelAccess", provider: route.provider };
        proposed = applyNativeRoute(model, route);
        const timeout = withTimeoutSignal(signal, INITIAL_CAPABILITY_BATCH_TIMEOUT_MS);
        try {
          const outcome = await tester.test({ connection, connectionId: snapshot.connectionId,
            connectionDisplayName: snapshot.connection.displayName, credentialId: key.id,
            credentialVersionIdentity: key.activeVersionId!, mode: "tiny_generation", model: proposed,
            modelDisplayName: snapshot.displayName, providerFamily: "openrouter", providerModelId: id,
            secret, signal: timeout.signal });
          timeout.signal.throwIfAborted();
          const evidence = validateEvidence(outcome, "tiny_generation", proposed);
          const missing = nativeRouteMissingCapabilities(proposed, candidate.priorEvidence, evidence);
          if (outcome.status !== "available" || missing.length > 0) {
            const check = outcome.status !== "available" ? "modelAccess" : missing[0]!;
            const attempt = evidence.capabilitySetup?.attempts?.[check];
            diagnostic = { ...diagnostic, stage: check === "modelAccess" ? "modelAccess" : "capabilities",
              code: attempt?.reason ?? "capability_mismatch", missing,
              ...(attempt?.httpStatus ? { httpStatus: attempt.httpStatus } : {}) };
            failure = "native_incompatible"; break;
          }
          proofs.push({ credentialId: key.id, versionId: key.activeVersionId!, outcome: { ...outcome, evidence } });
        } finally { timeout.clear(); }
      }
      signal?.throwIfAborted();
      if (failure || proofs.length !== keys.length) { await unresolved(failure ?? undefined); continue; }
      diagnostic = { ...diagnostic!, stage: "publication", code: "authority_changed" };
      const published = await db.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProviderConnection" WHERE "id" = ${snapshot.connectionId} FOR UPDATE`);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProviderModel" WHERE "id" = ${id} FOR UPDATE`);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProviderCredential" WHERE "connectionId" = ${snapshot.connectionId} ORDER BY "id" FOR UPDATE`);
        await tx.$queryRaw(Prisma.sql`SELECT version."id" FROM "ProviderCredentialVersion" version
          JOIN "ProviderCredential" credential ON credential."activeVersionId" = version."id"
          WHERE credential."connectionId" = ${snapshot.connectionId} ORDER BY version."id" FOR SHARE OF version`);
        const current = await tx.providerModel.findUnique({ where: { id }, include: snapshotInclude });
        if (!current || !current.enabled || !current.connection.enabled || current.activeVersion !== snapshot.activeVersion ||
          current.draftVersion !== snapshot.draftVersion || current.nativeRoutingAdoptionReason !== "verification_required" ||
          current.connection.activeVersion !== snapshot.connection.activeVersion ||
          current.connection.defaultCredentialId !== snapshot.connection.defaultCredentialId ||
          !isDeepStrictEqual(usableCredentials(current).map((key) => [key.id, key.activeVersionId]), keys.map((key) => [key.id, key.activeVersionId])) ||
          !isDeepStrictEqual([...current.activeCredentialChecks].sort((a, b) => a.id.localeCompare(b.id)),
            [...snapshot.activeCredentialChecks].sort((a, b) => a.id.localeCompare(b.id)))) return false;
        signal?.throwIfAborted();
        await tx.providerModel.update({ where: { id }, data: { activeVersion: snapshot.activeVersion + 1,
          draftVersion: snapshot.activeVersion + 1, activeConfig: proposed as Prisma.InputJsonValue,
          draftConfig: proposed as Prisma.InputJsonValue, defaultParams: proposed.defaultParams as Prisma.InputJsonValue,
          nativeRoutingAdoptionReason: "applied", nativeRoutingAdoptionEvidence: Prisma.DbNull } });
        await tx.providerModelCredentialCheck.createMany({ data: proofs.map(({ credentialId, versionId, outcome }) => ({
          connectionId: snapshot.connectionId, connectionVersion: snapshot.connection.activeVersion,
          providerModelId: id, modelVersion: snapshot.activeVersion + 1, credentialId, credentialVersionId: versionId,
          status: outcome.status, evidence: outcome.evidence as unknown as Prisma.InputJsonValue, checkedAt: new Date()
        })) });
        return true;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });
      if (published) totals.applied += 1;
      else await unresolved();
    } catch (error) {
      signal?.throwIfAborted();
      if (diagnostic) {
        const attempt = capabilityFailureAttempt(error, { attempts: 1, capability: "modelAccess",
          adapterKind: "openrouter_chat_completions", accessVerified: false, timedOut: false });
        diagnostic = { ...diagnostic, code: attempt.reason,
          ...(attempt.httpStatus ? { httpStatus: attempt.httpStatus } : {}) };
      }
      await unresolved();
    }
  }
  return totals;
}

let running: Promise<unknown> | undefined;
export function startNativeRoutingAdoption(): void {
  running ??= import("../prisma").then(({ prisma }) => adoptNativeOpenRouterRoutes({ db: prisma })).catch(() => {
    logEvent("service_operation", { subsystem: "admin", stage: "startup", outcome: "degraded", code: "native_route_adoption_failed" });
  });
}
