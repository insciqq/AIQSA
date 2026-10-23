import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  WorkspaceSecretErrorCode,
  WorkspaceSecretKind,
  WorkspaceSecretMutation,
  WorkspaceSecretValue
} from "@/lib/contracts/workspaceSecrets";
import { getSecretEncryptionKey } from "../../secrets/envelope";
import {
  commitSelfServiceChange,
  type SelfServiceCallStore,
  type SelfServiceCommitOutcome,
  type SelfServiceScope
} from "../../tools/selfServiceCall";
import type { ToolExecutionResult } from "../../tools/types";
import { isStoredObjectMissingError, isStoredObjectTooLargeError, type StorageAdapter } from "../../uploads/storage";
import { validateWorkspaceSshKey } from "./sshKey";
import { lockWorkspaceSecretOwner, mutateWorkspaceSecretInTransaction } from "./store";
import { parseWorkspaceSecretMutation, WorkspaceSecretError } from "./validation";

/**
 * The agent's access to its user's saved secrets (`manage_secret`): the same
 * settings mutation, validation, limits and revision rules as Studio ›
 * Secrets (`mutateWorkspaceSecretInTransaction`), committed together with
 * the tool call. Everything is scoped to the run's own user; another user's
 * secret looks exactly like a missing one. Values are never logged or
 * returned here.
 */

/** A saved secret as the agent addresses it: metadata only, never its value. */
export type AgentSecretView = Readonly<{
  id: string;
  versionId: string;
  name: string;
  description: string;
  kind: WorkspaceSecretKind;
  envNames: readonly string[];
}>;

export type AgentSecretSelector = Readonly<{ secretId: string }> | Readonly<{ name: string }>;

export type AgentSecretLookup =
  | Readonly<{ kind: "found"; secret: AgentSecretView }>
  | Readonly<{ kind: "missing"; available: readonly AgentSecretView[] }>
  | Readonly<{ kind: "ambiguous"; matches: readonly AgentSecretView[] }>;

const fold = (name: string) => name.trim().toLocaleLowerCase("en-US");

/** By id; else by exact name; else by a case-insensitive name only one secret has. */
export function findAgentSecret(secrets: readonly AgentSecretView[], selector: AgentSecretSelector): AgentSecretLookup {
  if ("secretId" in selector) {
    const secret = secrets.find((entry) => entry.id === selector.secretId);
    return secret ? { kind: "found", secret } : { kind: "missing", available: secrets };
  }
  const exact = secrets.filter((entry) => entry.name === selector.name.trim());
  const matches = exact.length ? exact : secrets.filter((entry) => fold(entry.name) === fold(selector.name));
  if (matches.length === 1) return { kind: "found", secret: matches[0]! };
  return matches.length ? { kind: "ambiguous", matches } : { kind: "missing", available: secrets };
}

export type AgentSecretChange =
  | Readonly<{ action: "create"; name: string; description: string; value: WorkspaceSecretValue }>
  | Readonly<{ action: "update"; selector: AgentSecretSelector; name: string | null; description: string | null;
      value: WorkspaceSecretValue | null }>;

export type AgentSecretChangeDone = Readonly<{
  action: "created" | "updated";
  secret: AgentSecretView;
  /** The secret before an update. */
  previous: AgentSecretView | null;
  valueReplaced: boolean;
}>;

export type AgentSecretRefusal =
  | Readonly<{ code: "secret_not_found"; available: readonly AgentSecretView[] }>
  | Readonly<{ code: "secret_ambiguous"; matches: readonly AgentSecretView[] }>
  | Readonly<{ code: "secret_name_taken"; existing: AgentSecretView }>
  | Readonly<{ code: "secret_kind_mismatch"; current: AgentSecretView }>
  | Readonly<{ code: "secret_unchanged"; current: AgentSecretView }>
  | Readonly<{ code: WorkspaceSecretErrorCode }>;

export type AgentSecretAttachment =
  | Readonly<{ kind: "file"; fileName: string; mimeType: string; bytes: Buffer }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "too_large"; byteSize: number }>;

export type AgentSecretService = Readonly<{
  /** Applies one change and settles the call with `result` in the same transaction. */
  change(change: AgentSecretChange, result: (done: AgentSecretChangeDone) => ToolExecutionResult):
    Promise<SelfServiceCommitOutcome<AgentSecretChangeDone, AgentSecretRefusal>>;
  /** The user's secret for a deletion proposal. */
  find(selector: AgentSecretSelector): Promise<AgentSecretLookup | null>;
  /** A file of this conversation the run admitted, by attachment id, read and checked whole. */
  readAttachment(attachmentId: string, maxBytes: number): Promise<AgentSecretAttachment>;
  validateSshKey(privateKey: string, passphrase: string): Promise<void>;
}>;

type SecretReader = Pick<Prisma.TransactionClient, "workspaceSecret">;

/** The user's saved secrets, oldest first, as `listForUser` orders them in Studio. */
export async function listAgentSecrets(db: SecretReader, userId: string): Promise<AgentSecretView[]> {
  const rows = await db.workspaceSecret.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, value: { select: { description: true, envNames: true, id: true, kind: true, name: true } } },
    where: { userId }
  });
  return rows.map((row) => ({ description: row.value.description, envNames: row.value.envNames, id: row.id,
    kind: row.value.kind as WorkspaceSecretKind, name: row.value.name, versionId: row.value.id }));
}

const envNamesOf = (value: WorkspaceSecretValue) => value.kind === "env" ? value.entries.map((entry) => entry.name) : [];
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type ServiceDatabase = Pick<PrismaClient, "$transaction" | "attachment" | "user" | "workspaceSecret">;

export function createAgentSecretService(input: Readonly<{
  db: ServiceDatabase;
  store: SelfServiceCallStore;
  scope: SelfServiceScope;
  /** Conversation files the run admitted; besides them only files the run produced are read. */
  attachmentIds?: readonly string[];
  storage?: Pick<StorageAdapter, "getObject">;
  key?: () => Buffer;
  mutate?: typeof mutateWorkspaceSecretInTransaction;
  validateSshKey?: typeof validateWorkspaceSshKey;
}>): AgentSecretService {
  const { db, scope } = input;
  const key = input.key ?? getSecretEncryptionKey;
  const mutate = input.mutate ?? mutateWorkspaceSecretInTransaction;
  const userId = scope.userId;

  async function apply(tx: Prisma.TransactionClient, mutation: WorkspaceSecretMutation) {
    // The settings route's own decoder: names, descriptions and value bounds as Studio checks them.
    const saved = await mutate(tx, userId, parseWorkspaceSecretMutation(mutation), key);
    if (!saved) throw new Error("agent_secret_mutation_result_missing");
    return saved;
  }

  return {
    async change(change, result) {
      try {
        return await commitSelfServiceChange<AgentSecretChangeDone, AgentSecretRefusal>(input.db, input.store, async (tx) => {
          await lockWorkspaceSecretOwner(tx, userId, true);
          const secrets = await listAgentSecrets(tx, userId);
          const refuse = (value: AgentSecretRefusal) => ({ kind: "refused" as const, value });
          const changed = (done: AgentSecretChangeDone) => ({ kind: "changed" as const, value: done, result: result(done) });
          if (change.action === "create") {
            const name = change.name.trim();
            const existing = secrets.find((entry) => fold(entry.name) === fold(name));
            if (existing) return refuse({ code: "secret_name_taken", existing });
            const saved = await apply(tx, { action: "create", description: change.description, name, value: change.value });
            return changed({ action: "created", previous: null, valueReplaced: false, secret: { description: change.description,
              envNames: envNamesOf(change.value), id: saved.id, kind: change.value.kind, name, versionId: saved.versionId } });
          }
          const lookup = findAgentSecret(secrets, change.selector);
          if (lookup.kind === "missing") return refuse({ code: "secret_not_found", available: lookup.available });
          if (lookup.kind === "ambiguous") return refuse({ code: "secret_ambiguous", matches: lookup.matches });
          const current = lookup.secret;
          if (change.value && change.value.kind !== current.kind) return refuse({ code: "secret_kind_mismatch", current });
          const name = change.name?.trim() || current.name;
          const existing = name !== current.name
            ? secrets.find((entry) => entry.id !== current.id && fold(entry.name) === fold(name)) : undefined;
          if (existing) return refuse({ code: "secret_name_taken", existing });
          const description = change.description ?? current.description;
          if (!change.value && name === current.name && description === current.description) return refuse({ code: "secret_unchanged", current });
          const saved = await apply(tx, { action: "update", description, expectedVersionId: current.versionId, id: current.id, name,
            value: change.value ? { action: "replace", content: change.value } : { action: "preserve" } });
          return changed({ action: "updated", previous: current, valueReplaced: change.value !== null, secret: { ...current, description,
            envNames: change.value ? envNamesOf(change.value) : current.envNames, name, versionId: saved.versionId } });
        });
      } catch (error) {
        // Thrown inside the transaction, so nothing was written and the call stays unsettled.
        if (error instanceof WorkspaceSecretError) return { kind: "refused", value: { code: error.code } };
        throw error;
      }
    },

    async find(selector) {
      const owner = await db.user.findFirst({ select: { id: true }, where: { id: userId, status: "active" } });
      return owner ? findAgentSecret(await listAgentSecrets(db, userId), selector) : null;
    },

    async readAttachment(attachmentId, maxBytes) {
      if (!input.storage) return { kind: "missing" };
      // Only a file of this chat the run admitted or produced, of this user.
      const row = await db.attachment.findFirst({
        select: { byteSize: true, checksum: true, fileName: true, mimeType: true, storageKey: true },
        where: { chatId: scope.chatId, id: attachmentId, userId,
          OR: [...input.attachmentIds?.length ? [{ id: { in: [...input.attachmentIds] } }] : [], { producerModelRunId: scope.runId }] }
      });
      if (!row || !row.checksum || row.byteSize < 1) return { kind: "missing" };
      if (row.byteSize > maxBytes) return { kind: "too_large", byteSize: row.byteSize };
      let bytes: Buffer;
      try {
        bytes = (await input.storage.getObject(row.storageKey, { maxBytes: row.byteSize })).body;
      } catch (error) {
        if (isStoredObjectMissingError(error) || isStoredObjectTooLargeError(error)) return { kind: "missing" };
        throw error;
      }
      if (bytes.byteLength !== row.byteSize || sha256(bytes) !== row.checksum) return { kind: "missing" };
      return { bytes, fileName: row.fileName, kind: "file", mimeType: row.mimeType };
    },

    validateSshKey: input.validateSshKey ?? validateWorkspaceSshKey
  };
}
