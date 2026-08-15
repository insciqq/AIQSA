import type { MemorySuppression } from "@prisma/client";
import type { MemorySuppressionKeyring } from "../suppressionKeyring";
import { memoryPersistenceFailure } from "./errors";
import {
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  normalizeMemorySearchText
} from "./lexical";
import {
  advanceMemoryMutation,
  type LockedMemorySettings,
  type MemoryTransaction
} from "./transaction";

type MemorySuppressionCommonInput = Readonly<{
  expiresAt?: Date | null;
  explicitOverrideAllowed: boolean;
  normalizationVersion?: string;
  suppressionId: string;
}>;

export type MemorySuppressionCreateInput = MemorySuppressionCommonInput & (
  | Readonly<{ scope: "ALL" }>
  | Readonly<{ canonicalKey: string; scope: "FACT" }>
  | Readonly<{ category: string; scope: "CATEGORY" }>
  | Readonly<{ normalizedValue: string; scope: "VALUE" }>
  | Readonly<{
      branchGeneration: number;
      chatId: string;
      messageId: string;
      scope: "SOURCE_MESSAGE";
    }>
);

export type MemorySuppressionMatchInput = Readonly<{
  canonicalKey: string;
  category: string;
  normalizedValue: string;
  source?: Readonly<{
    branchGeneration: number;
    chatId: string;
    messageId: string;
  }>;
}>;

export type MemorySuppressionWritePolicy = Readonly<{
  explicitOverrideRequested: boolean;
  sourceMode: "AUTOMATIC" | "EXPLICIT";
}>;

export type MemorySuppressionCreateResult = Readonly<{
  created: boolean;
  deletionGeneration: number;
  id: string;
}>;

const canonicalKeyPattern = /^[a-z][a-z0-9_.:-]{0,255}$/u;
const categoryPattern = /^[a-z][a-z0-9_-]{0,63}$/u;

function validBounded(value: string, maxLength: number): boolean {
  return value.trim() === value && value.length > 0 && value.length <= maxLength;
}

function categoryFingerprintValue(category: string): string {
  return `category:${category}`;
}

function mapVerificationBlocked(
  result: ReturnType<MemorySuppressionKeyring["verify"]>
): never {
  if (result.status !== "blocked") {
    return memoryPersistenceFailure("memory_suppression_fingerprint_invalid");
  }
  return memoryPersistenceFailure(result.code);
}

function validateCreateInput(input: MemorySuppressionCreateInput): string {
  const normalizationVersion = input.normalizationVersion ?? MEMORY_LEXICAL_NORMALIZATION_VERSION;
  if (
    !validBounded(input.suppressionId, 256) ||
    !validBounded(normalizationVersion, 64) ||
    (input.expiresAt !== undefined && input.expiresAt !== null &&
      !Number.isFinite(input.expiresAt.getTime()))
  ) {
    return memoryPersistenceFailure("memory_suppression_shape_invalid");
  }
  if (input.scope === "FACT" && !canonicalKeyPattern.test(input.canonicalKey)) {
    return memoryPersistenceFailure("memory_suppression_shape_invalid");
  }
  if (input.scope === "CATEGORY" && !categoryPattern.test(input.category)) {
    return memoryPersistenceFailure("memory_suppression_shape_invalid");
  }
  if (input.scope === "VALUE" && !normalizeMemorySearchText(input.normalizedValue)) {
    return memoryPersistenceFailure("memory_suppression_shape_invalid");
  }
  if (input.scope === "SOURCE_MESSAGE" && (
    !validBounded(input.chatId, 256) ||
    !validBounded(input.messageId, 256) ||
    !Number.isSafeInteger(input.branchGeneration) ||
    input.branchGeneration < 0
  )) {
    return memoryPersistenceFailure("memory_suppression_shape_invalid");
  }
  return normalizationVersion;
}

function ensureHistoricalKeyAvailable(
  keyring: MemorySuppressionKeyring,
  suppression: Pick<MemorySuppression, "fingerprintKeyVersion">
): void {
  if (!keyring.hasKey(suppression.fingerprintKeyVersion)) {
    return memoryPersistenceFailure("memory_suppression_historical_key_missing");
  }
}

function fingerprintMatches(
  keyring: MemorySuppressionKeyring,
  suppression: Pick<
    MemorySuppression,
    "fingerprintKeyVersion" | "normalizationVersion" | "userId"
  >,
  purpose: "canonical_key" | "normalized_value",
  storedFingerprint: string,
  value: string
): boolean {
  const result = keyring.verify({
    normalizationVersion: suppression.normalizationVersion,
    purpose,
    userId: suppression.userId,
    value
  }, {
    fingerprint: storedFingerprint,
    fingerprintKeyVersion: suppression.fingerprintKeyVersion
  });
  if (result.status === "blocked") return mapVerificationBlocked(result);
  return result.status === "match";
}

export async function findMatchingMemorySuppressions(
  tx: MemoryTransaction,
  keyring: MemorySuppressionKeyring,
  userId: string,
  input: MemorySuppressionMatchInput
): Promise<MemorySuppression[]> {
  if (
    !canonicalKeyPattern.test(input.canonicalKey) ||
    !categoryPattern.test(input.category) ||
    !input.normalizedValue
  ) {
    return memoryPersistenceFailure("memory_input_invalid");
  }
  const sourceClause = input.source ? [{
    scope: "SOURCE_MESSAGE" as const,
    sourceBranchGeneration: input.source.branchGeneration,
    sourceChatId: input.source.chatId,
    sourceMessageId: input.source.messageId
  }] : [];
  const candidates = await tx.memorySuppression.findMany({
    where: {
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        {
          OR: [
            { scope: { in: ["ALL", "CATEGORY", "FACT", "VALUE"] } },
            ...sourceClause
          ]
        }
      ],
      userId
    }
  });

  const matches: MemorySuppression[] = [];
  for (const candidate of candidates) {
    if (candidate.scope === "ALL" || candidate.scope === "SOURCE_MESSAGE") {
      ensureHistoricalKeyAvailable(keyring, candidate);
      matches.push(candidate);
      continue;
    }
    if (candidate.scope === "FACT" && candidate.canonicalKeyHash && fingerprintMatches(
      keyring,
      candidate,
      "canonical_key",
      candidate.canonicalKeyHash,
      input.canonicalKey
    )) {
      matches.push(candidate);
      continue;
    }
    if (candidate.scope === "CATEGORY" && candidate.canonicalKeyHash && fingerprintMatches(
      keyring,
      candidate,
      "canonical_key",
      candidate.canonicalKeyHash,
      categoryFingerprintValue(input.category)
    )) {
      matches.push(candidate);
      continue;
    }
    if (candidate.scope === "VALUE" && candidate.normalizedValueHash && fingerprintMatches(
      keyring,
      candidate,
      "normalized_value",
      candidate.normalizedValueHash,
      normalizeMemorySearchText(input.normalizedValue)
    )) {
      matches.push(candidate);
    }
  }
  return matches;
}

export async function assertMemoryWriteNotSuppressed(
  tx: MemoryTransaction,
  keyring: MemorySuppressionKeyring,
  userId: string,
  input: MemorySuppressionMatchInput,
  policy: MemorySuppressionWritePolicy
): Promise<void> {
  const matches = await findMatchingMemorySuppressions(tx, keyring, userId, input);
  if (matches.length === 0) return;
  if (
    policy.sourceMode === "EXPLICIT" &&
    policy.explicitOverrideRequested &&
    matches.every((match) => match.explicitOverrideAllowed)
  ) {
    return;
  }
  return memoryPersistenceFailure("memory_fact_suppressed");
}

async function sourceOwnerIsValid(
  tx: MemoryTransaction,
  userId: string,
  input: Extract<MemorySuppressionCreateInput, { scope: "SOURCE_MESSAGE" }>
): Promise<boolean> {
  const [chat, message] = await Promise.all([
    tx.chat.findFirst({ select: { id: true }, where: { id: input.chatId, userId } }),
    tx.message.findFirst({
      select: { id: true },
      where: { chatId: input.chatId, id: input.messageId }
    })
  ]);
  return Boolean(chat && message);
}

function existingSuppressionMatches(
  keyring: MemorySuppressionKeyring,
  existing: MemorySuppression,
  input: MemorySuppressionCreateInput,
  normalizationVersion: string
): boolean {
  if (
    existing.scope !== input.scope ||
    existing.normalizationVersion !== normalizationVersion ||
    existing.explicitOverrideAllowed !== input.explicitOverrideAllowed ||
    (existing.expiresAt?.getTime() ?? null) !== (input.expiresAt?.getTime() ?? null)
  ) return false;
  if (input.scope === "ALL") {
    ensureHistoricalKeyAvailable(keyring, existing);
    return true;
  }
  if (input.scope === "FACT" && existing.canonicalKeyHash) {
    return fingerprintMatches(
      keyring,
      existing,
      "canonical_key",
      existing.canonicalKeyHash,
      input.canonicalKey
    );
  }
  if (input.scope === "CATEGORY" && existing.canonicalKeyHash) {
    return fingerprintMatches(
      keyring,
      existing,
      "canonical_key",
      existing.canonicalKeyHash,
      categoryFingerprintValue(input.category)
    );
  }
  if (input.scope === "VALUE" && existing.normalizedValueHash) {
    return fingerprintMatches(
      keyring,
      existing,
      "normalized_value",
      existing.normalizedValueHash,
      normalizeMemorySearchText(input.normalizedValue)
    );
  }
  if (input.scope === "SOURCE_MESSAGE") {
    ensureHistoricalKeyAvailable(keyring, existing);
    return existing.sourceChatId === input.chatId &&
      existing.sourceMessageId === input.messageId &&
      existing.sourceBranchGeneration === input.branchGeneration;
  }
  return false;
}

function suppressionFingerprintData(
  keyring: MemorySuppressionKeyring,
  userId: string,
  input: MemorySuppressionCreateInput,
  normalizationVersion: string
): Pick<MemorySuppression, "canonicalKeyHash" | "fingerprintKeyVersion" | "normalizedValueHash"> {
  if (input.scope === "FACT" || input.scope === "CATEGORY") {
    const fingerprint = keyring.fingerprint({
      normalizationVersion,
      purpose: "canonical_key",
      userId,
      value: input.scope === "FACT" ? input.canonicalKey : categoryFingerprintValue(input.category)
    });
    return {
      canonicalKeyHash: fingerprint.fingerprint,
      fingerprintKeyVersion: fingerprint.fingerprintKeyVersion,
      normalizedValueHash: null
    };
  }
  if (input.scope === "VALUE") {
    const fingerprint = keyring.fingerprint({
      normalizationVersion,
      purpose: "normalized_value",
      userId,
      value: normalizeMemorySearchText(input.normalizedValue)
    });
    return {
      canonicalKeyHash: null,
      fingerprintKeyVersion: fingerprint.fingerprintKeyVersion,
      normalizedValueHash: fingerprint.fingerprint
    };
  }
  return {
    canonicalKeyHash: null,
    fingerprintKeyVersion: keyring.currentKeyId,
    normalizedValueHash: null
  };
}

export async function createMemorySuppressionInTransaction(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  keyring: MemorySuppressionKeyring,
  input: MemorySuppressionCreateInput,
  options: Readonly<{ advanceMemory?: boolean }> = {}
): Promise<MemorySuppressionCreateResult> {
  const normalizationVersion = validateCreateInput(input);
  const prior = await tx.memorySuppression.findUnique({ where: { id: input.suppressionId } });
  if (prior) {
    if (
      prior.userId !== settings.userId ||
      !existingSuppressionMatches(keyring, prior, input, normalizationVersion)
    ) {
      return memoryPersistenceFailure("memory_idempotency_conflict");
    }
    return { created: false, deletionGeneration: prior.deletionGeneration, id: prior.id };
  }
  if (input.scope === "SOURCE_MESSAGE" &&
    !(await sourceOwnerIsValid(tx, settings.userId, input))) {
    return memoryPersistenceFailure("memory_scope_unavailable");
  }

  if (options.advanceMemory ?? true) {
    await advanceMemoryMutation(tx, settings, "FORGET_OR_BULK_CLEAR");
  }
  const fingerprint = suppressionFingerprintData(
    keyring,
    settings.userId,
    input,
    normalizationVersion
  );
  const created = await tx.memorySuppression.create({
    data: {
      ...fingerprint,
      deletionGeneration: settings.memoryGeneration,
      expiresAt: input.expiresAt,
      explicitOverrideAllowed: input.explicitOverrideAllowed,
      id: input.suppressionId,
      normalizationVersion,
      scope: input.scope,
      sourceBranchGeneration: input.scope === "SOURCE_MESSAGE"
        ? input.branchGeneration
        : null,
      sourceChatId: input.scope === "SOURCE_MESSAGE" ? input.chatId : null,
      sourceMessageId: input.scope === "SOURCE_MESSAGE" ? input.messageId : null,
      userId: settings.userId
    },
    select: { deletionGeneration: true, id: true }
  });
  return { ...created, created: true };
}
