import { Prisma, type PrismaClient } from "@prisma/client";
import {
  loadEmbeddingProviderRole,
  ProviderAdmissionError,
  type EmbeddingProviderAdmissionRole,
  type ProviderAdmissionRole
} from "../../providerRuntime/admission";
import {
  createSystemModelRoleResolver,
  type SystemModelRoleResolution
} from "../../providerRuntime/systemModelRole";
import { decryptProviderCredentialSecret } from "../../providers/credentialSecrets";
import { providerAuthenticationMode } from "../../providers/providerConfiguration";
import {
  normalizeProviderExecutionSnapshot,
  type ProviderExecutionSnapshot
} from "../../providers/runtimeFactory";

type EnabledMemoryOwner = Readonly<{
  embeddingProviderModelId: string | null;
  userId: string;
}>;

type ProviderCredentialVersion = Readonly<{
  credentialId: string;
  id: string;
  revokedAt: Date | null;
  secretEnvelope: string | null;
  testEvidence: unknown;
}>;

type BoundProviderRole = ProviderAdmissionRole | EmbeddingProviderAdmissionRole;

export type MemoryProviderBindingPreflightDependencies = Readonly<{
  encryptionKey: Buffer;
  listEnabledOwners(): Promise<readonly EnabledMemoryOwner[]>;
  loadCredentialVersion(input: Readonly<{
    credentialId: string;
    credentialVersionId: string;
  }>): Promise<ProviderCredentialVersion | null>;
  resolveEmbedding(input: Readonly<{
    providerModelId: string;
    userId: string;
  }>): Promise<EmbeddingProviderAdmissionRole>;
  resolveSystemModel(): Promise<SystemModelRoleResolution>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noAuthEvidence(value: unknown): boolean {
  return isRecord(value) && value.authenticationMode === "none";
}

function invalidBinding(code: string): never {
  throw new Error(code);
}

async function assertCredentialReadable(
  dependencies: MemoryProviderBindingPreflightDependencies,
  role: BoundProviderRole,
  validatedCredentials: Set<string>
): Promise<void> {
  let snapshot: ProviderExecutionSnapshot;
  try {
    snapshot = normalizeProviderExecutionSnapshot(role.snapshot);
  } catch {
    return invalidBinding("memory_provider_binding_invalid");
  }
  const authority = role.authority;
  if (
    !authority ||
    !snapshot.credentialId ||
    !snapshot.credentialVersionId ||
    authority.connectionId !== snapshot.connectionId ||
    authority.providerModelId !== snapshot.providerModelId ||
    authority.credentialId !== snapshot.credentialId ||
    authority.credentialVersionId !== snapshot.credentialVersionId
  ) {
    return invalidBinding("memory_provider_binding_invalid");
  }

  const identity = `${snapshot.credentialId}\u0000${snapshot.credentialVersionId}`;
  if (validatedCredentials.has(identity)) return;
  const version = await dependencies.loadCredentialVersion({
    credentialId: snapshot.credentialId,
    credentialVersionId: snapshot.credentialVersionId
  });
  const expectNoAuth = providerAuthenticationMode(snapshot.connection) === "none";
  if (
    !version ||
    version.revokedAt !== null ||
    version.credentialId !== snapshot.credentialId ||
    version.id !== snapshot.credentialVersionId ||
    expectNoAuth !== noAuthEvidence(version.testEvidence) ||
    expectNoAuth !== (version.secretEnvelope === null)
  ) {
    return invalidBinding("memory_provider_credential_unreadable");
  }
  if (version.secretEnvelope !== null) {
    try {
      decryptProviderCredentialSecret({
        credentialId: version.credentialId,
        envelope: version.secretEnvelope,
        key: dependencies.encryptionKey,
        valueId: version.id
      });
    } catch {
      return invalidBinding("memory_provider_credential_unreadable");
    }
  }
  validatedCredentials.add(identity);
}

/**
 * Resolve the same effective installation System Model and per-owner embedding
 * roles used by Memory admission, then prove that every currently admitted
 * binding's exact credential version can be read with this process's envelope
 * key. An absent or currently unavailable capability is not a process-wide
 * startup blocker: deletion, suppression, and manual management remain usable.
 * This performs no provider request.
 */
export async function preflightMemoryProviderBindings(
  dependencies: MemoryProviderBindingPreflightDependencies
): Promise<void> {
  const owners = await dependencies.listEnabledOwners();
  const validatedCredentials = new Set<string>();
  let systemModel: SystemModelRoleResolution;
  try {
    systemModel = await dependencies.resolveSystemModel();
  } catch {
    return invalidBinding("memory_system_model_binding_invalid");
  }
  if (
    systemModel.ok &&
    systemModel.role.modelConfiguration.adapterKind !== "fake"
  ) {
    await assertCredentialReadable(
      dependencies,
      systemModel.role,
      validatedCredentials
    );
  }

  for (const owner of owners) {
    if (!owner.embeddingProviderModelId) continue;
    let embedding: EmbeddingProviderAdmissionRole;
    try {
      embedding = await dependencies.resolveEmbedding({
        providerModelId: owner.embeddingProviderModelId,
        userId: owner.userId
      });
    } catch (error) {
      if (error instanceof ProviderAdmissionError) continue;
      return invalidBinding("memory_embedding_binding_invalid");
    }
    await assertCredentialReadable(dependencies, embedding, validatedCredentials);
  }
}

export async function preflightPrismaMemoryProviderBindings(
  client: PrismaClient,
  encryptionKey: Buffer
): Promise<void> {
  const systemModelResolver = createSystemModelRoleResolver(client);
  return preflightMemoryProviderBindings({
    encryptionKey,
    listEnabledOwners: () => client.$queryRaw<EnabledMemoryOwner[]>(Prisma.sql`
      SELECT settings."userId", settings."embeddingProviderModelId"
      FROM "UserMemorySettings" AS settings
      INNER JOIN "User" AS owner_user ON owner_user."id" = settings."userId"
      WHERE owner_user."status" = 'active'::"UserStatus"
        AND settings."useMemoryFacts" = TRUE
      ORDER BY settings."userId"
    `),
    loadCredentialVersion: (input) => client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<ProviderCredentialVersion[]>(Prisma.sql`
        SELECT "credentialId", "id", "revokedAt", "secretEnvelope", "testEvidence"
        FROM "ProviderCredentialVersion"
        WHERE "credentialId" = ${input.credentialId}
          AND "id" = ${input.credentialVersionId}
        FOR SHARE
      `);
      return rows[0] ?? null;
    }),
    resolveEmbedding: (input) => loadEmbeddingProviderRole(client, input),
    resolveSystemModel: () => systemModelResolver.resolve()
  });
}
