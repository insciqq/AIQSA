import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type WorkspaceSecretValue as StoredValue } from "@prisma/client";
import {
  WORKSPACE_SECRET_MAX_COUNT, WORKSPACE_SECRET_TOTAL_MAX_BYTES, WORKSPACE_SECRET_ENV_MAX_BYTES,
  WORKSPACE_BROWSER_SESSION_MAX_COUNT,
  type WorkspaceSecretMutation, type WorkspaceSecretSummary, type WorkspaceSecretValue
} from "@/lib/contracts/workspaceSecrets";
import { decryptSecretEnvelope, encryptSecretEnvelope, getSecretEncryptionKey } from "../../secrets/envelope";
import { parseWorkspaceSecretMutation, parseWorkspaceSecretValue, WorkspaceSecretError } from "./validation";
import { validateWorkspaceSshKey } from "./sshKey";
import { workspaceBrowserSessionChecksum } from "./browserSession";

const PURPOSE = "workspace-user-secret";
const summarySelect = {
  id: true, secretId: true, kind: true, name: true, description: true, byteSize: true,
  envNames: true, originalName: true, sshProtected: true, createdAt: true, autoSaved: true
} as const;

export type AcceptedWorkspaceSecret = Readonly<{
  id: string;
  versionId: string;
  name: string;
  description: string;
  value: WorkspaceSecretValue;
}>;

export interface WorkspaceSecretStore {
  list(userId: string): Promise<readonly WorkspaceSecretSummary[]>;
  mutate(userId: string, mutation: WorkspaceSecretMutation): Promise<void>;
}

export async function lockWorkspaceSecretOwner(tx: Prisma.TransactionClient, userId: string, write = false): Promise<void> {
  // Mutations write the owner tuple without changing profile data. A repeatable-
  // read admission waiting on this lock must retry its snapshot, rather than
  // reference an old unbound revision the mutation has just garbage-collected.
  const owners = await tx.$queryRaw<Array<{ id: string }>>(write ? Prisma.sql`
    UPDATE "User" SET "id" = "id" WHERE "id" = ${userId} AND "status" = 'active' RETURNING "id"
  ` : Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${userId} AND "status" = 'active' FOR UPDATE`);
  if (owners.length !== 1) throw new WorkspaceSecretError("workspace_secret_unavailable");
}

export async function advanceWorkspaceBrowserSequence(tx: Prisma.TransactionClient, userId: string, manual = false): Promise<bigint> {
  const owner = await tx.user.update({ where: { id: userId }, data: { workspaceBrowserSequence: { increment: 1 } }, select: { workspaceBrowserSequence: true } });
  if (manual) await tx.user.update({ where: { id: userId }, data: { workspaceBrowserManualSequence: owner.workspaceBrowserSequence } });
  return owner.workspaceBrowserSequence;
}

export async function acceptWorkspaceBrowserSequence(tx: Prisma.TransactionClient, userId: string, chatId: string): Promise<bigint | null> {
  const chat = await tx.chat.findUniqueOrThrow({ where: { id: chatId }, select: { userId: true, projectId: true } });
  if (chat.projectId) return null;
  if (chat.userId !== userId) throw new WorkspaceSecretError("workspace_secret_unavailable");
  await lockWorkspaceSecretOwner(tx, userId);
  return advanceWorkspaceBrowserSequence(tx, userId);
}

export async function createWorkspaceSecretRevision(tx: Prisma.TransactionClient, input: Readonly<{
  userId: string; secretId: string; name: string; description: string; value: WorkspaceSecretValue; key: Buffer; autoSaved?: boolean;
}>): Promise<string> {
  const { userId, secretId, value, key } = input;
  const versionId = randomUUID();
  const browserBytes = value.kind === "browser_session" ? Buffer.from(value.base64, "base64") : null;
  await tx.workspaceSecretValue.create({ data: {
    id: versionId, userId, secretId, kind: value.kind, name: input.name, description: input.description,
    byteSize: browserBytes?.byteLength ?? Buffer.byteLength(JSON.stringify(value), "utf8"),
    envNames: value.kind === "env" ? value.entries.map(({ name }) => name) : [],
    originalName: value.kind === "file" || value.kind === "browser_session" ? value.originalName : null,
    sshProtected: value.kind === "ssh_key" && value.passphrase.length > 0,
    autoSaved: value.kind === "browser_session" && input.autoSaved === true,
    checksum: browserBytes ? workspaceBrowserSessionChecksum(browserBytes) : null,
    payloadEnvelope: encryptSecretEnvelope(value, key, { ownerId: userId, purpose: PURPOSE, valueId: versionId })
  } });
  return versionId;
}

export async function pruneWorkspaceSecretRevisions(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.workspaceSecretValue.deleteMany({ where: { userId, currentSecret: { is: null }, runBindings: { none: {} } } });
}

/** Called inside canonical admission, never from normalized prompt/browser data. */
export async function bindWorkspaceSecrets(tx: Prisma.TransactionClient, input: { runId: string; userId: string; chatId: string }): Promise<void> {
  const chat = await tx.chat.findUnique({ select: { userId: true, projectId: true }, where: { id: input.chatId } });
  if (!chat) throw new WorkspaceSecretError("workspace_secret_unavailable");
  if (chat.projectId) return;
  if (chat.userId !== input.userId) throw new WorkspaceSecretError("workspace_secret_unavailable");
  await lockWorkspaceSecretOwner(tx, input.userId);
  const secrets = await tx.workspaceSecret.findMany({
    select: { id: true, valueId: true, browserFileName: true }, where: { userId: input.userId }, orderBy: { id: "asc" }
  });
  if (secrets.filter((entry) => entry.browserFileName === null).length > WORKSPACE_SECRET_MAX_COUNT ||
    secrets.filter((entry) => entry.browserFileName !== null).length > WORKSPACE_BROWSER_SESSION_MAX_COUNT) throw new WorkspaceSecretError("workspace_secret_limit");
  if (secrets.length) await tx.workspaceRunSecret.createMany({
    data: secrets.map(({ id, valueId }) => ({ modelRunId: input.runId, secretId: id, valueId }))
  });
}

export function decryptWorkspaceSecret(value: StoredValue, userId: string, key = getSecretEncryptionKey()): AcceptedWorkspaceSecret {
  if (value.userId !== userId) throw new WorkspaceSecretError("workspace_secret_unavailable");
  try {
    const content = parseWorkspaceSecretValue(decryptSecretEnvelope(value.payloadEnvelope, key, {
      ownerId: userId, purpose: PURPOSE, valueId: value.id
    }));
    if (content.kind !== value.kind) throw new Error("kind_mismatch");
    return { id: value.secretId, versionId: value.id, name: value.name, description: value.description, value: content };
  } catch { throw new WorkspaceSecretError("workspace_secret_unavailable"); }
}

export function createWorkspaceSecretStore(prisma: PrismaClient, options: Readonly<{
  key?: () => Buffer;
  validateSshKey?: typeof validateWorkspaceSshKey;
}> = {}): WorkspaceSecretStore {
  const encryptionKey = options.key ?? getSecretEncryptionKey;
  const validateSshKey = options.validateSshKey ?? validateWorkspaceSshKey;
  return {
    async list(userId) {
      const owner = await prisma.user.findFirst({ select: { id: true }, where: { id: userId, status: "active" } });
      if (!owner) throw new WorkspaceSecretError("workspace_secret_unavailable");
      const rows = await prisma.workspaceSecret.findMany({
        select: { value: { select: summarySelect } },
        where: { userId, user: { status: "active" } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }]
      });
      return rows.map(({ value }) => ({
        id: value.secretId, versionId: value.id, kind: value.kind as WorkspaceSecretSummary["kind"],
        name: value.name, description: value.description, byteSize: value.byteSize, updatedAt: value.createdAt.toISOString(),
        envNames: value.envNames, originalName: value.originalName, sshProtected: value.sshProtected,
        ...(value.kind === "browser_session" ? { browserSession: { autoSaved: value.autoSaved } } : {})
      }));
    },
    async mutate(userId, raw) {
      const mutation = parseWorkspaceSecretMutation(raw);
      const replacement = mutation.action === "create" ? mutation.value
        : mutation.action === "update" && mutation.value.action === "replace" ? mutation.value.content : null;
      if (replacement?.kind === "ssh_key") await validateSshKey(replacement.privateKey, replacement.passphrase);
      await prisma.$transaction(async (tx) => {
        await lockWorkspaceSecretOwner(tx, userId, true);
        const current = mutation.action === "create" ? null : await tx.workspaceSecret.findFirst({
          include: { value: true }, where: { id: mutation.id, userId }
        });
        if (mutation.action !== "create" && (!current || current.valueId !== mutation.expectedVersionId)) {
          throw new WorkspaceSecretError("workspace_secret_conflict");
        }
        const browserSequence = current?.value.kind === "browser_session" || replacement?.kind === "browser_session"
          ? await advanceWorkspaceBrowserSequence(tx, userId, true) : 0n;
        if (mutation.action === "delete") {
          await tx.workspaceSecret.delete({ where: { id: mutation.id } });
        } else {
          const value = replacement ?? decryptWorkspaceSecret(current!.value, userId, encryptionKey()).value;
          if (current && value.kind !== current.value.kind) throw new WorkspaceSecretError("workspace_secret_invalid");
          const others = await tx.workspaceSecret.findMany({
            select: { browserFileName: true, value: { select: { byteSize: true, envNames: true, kind: true } } },
            where: { userId, ...(current ? { id: { not: current.id } } : {}) }
          });
          const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
          const ordinary = others.filter((entry) => entry.value.kind !== "browser_session");
          const browsers = others.filter((entry) => entry.value.kind === "browser_session");
          if (value.kind === "browser_session" && browsers.some((entry) => entry.browserFileName === value.originalName)) {
            throw new WorkspaceSecretError("workspace_browser_session_conflict");
          }
          if ((value.kind === "browser_session" ? browsers.length >= WORKSPACE_BROWSER_SESSION_MAX_COUNT :
            ordinary.length >= WORKSPACE_SECRET_MAX_COUNT || ordinary.reduce((total, entry) => total + entry.value.byteSize, bytes) > WORKSPACE_SECRET_TOTAL_MAX_BYTES) ||
            others.reduce((total, entry) => total + (entry.value.kind === "env" ? entry.value.byteSize : 0), value.kind === "env" ? bytes : 0) > WORKSPACE_SECRET_ENV_MAX_BYTES) {
            throw new WorkspaceSecretError("workspace_secret_limit");
          }
          const envNames = value.kind === "env" ? value.entries.map(({ name }) => name) : [];
          if (others.some((entry) => entry.value.envNames.some((name) => envNames.includes(name)))) {
            throw new WorkspaceSecretError("workspace_secret_env_conflict");
          }
          const id = current?.id ?? randomUUID();
          const versionId = await createWorkspaceSecretRevision(tx, { userId, secretId: id, value, key: encryptionKey(),
            name: mutation.name.trim(), description: mutation.description, autoSaved: !replacement && current?.value.autoSaved });
          const browser = { browserFileName: value.kind === "browser_session" ? value.originalName : null, browserWriterSequence: browserSequence };
          if (current) await tx.workspaceSecret.update({ data: { valueId: versionId, ...browser }, where: { id } });
          else await tx.workspaceSecret.create({ data: { id, userId, valueId: versionId, ...browser } });
        }
        // Revisions still used by an accepted run survive replacement/deletion.
        await pruneWorkspaceSecretRevisions(tx, userId);
      });
    }
  };
}
