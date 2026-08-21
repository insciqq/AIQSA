import type { PrismaClient } from "@prisma/client";
import {
  decodeMemoryActionFeedback as decodePersistedMemoryActionFeedback,
  type MemoryActionFeedback as PersistedMemoryActionFeedback
} from "../../../contracts/memory";
import {
  type MemoryActionResultItem,
  type MemoryActionFeedback
} from "../../../contracts/memoryClient";
import {
  defaultMemoryClientRefService,
  type MemoryClientRefPayload,
  type MemoryClientRefService
} from "./clientRef";
import {
  loadPersonalEligibleFactVersionIds,
  loadPersonalMemoryRunIds
} from "../persistence/eligibility";
import { canonicalGlobalMemoryScopeWhere } from "../persistence/scopes";

type MemoryRunActionClient = Pick<
  PrismaClient,
  | "$queryRaw"
  | "memoryFact"
  | "memoryFactVersion"
  | "memoryRetrievalAttempt"
  | "memoryScope"
  | "modelRun"
>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Rejoins statement-bearing action results to the exact current fact version
 * before projecting them. Provider output, mutation authorizations,
 * repository identifiers, and uncommitted tool calls are never exposed.
 */
export async function loadMemoryRunActions(
  client: MemoryRunActionClient,
  input: Readonly<{
    clientRefs?: MemoryClientRefService;
    now?: Date;
    runIds: readonly string[];
    userId: string;
  }>
): Promise<ReadonlyMap<string, MemoryActionFeedback>> {
  const runIds = [...new Set(input.runIds.filter(Boolean))];
  if (runIds.length === 0) return new Map();
  const personalRunIds = await loadPersonalMemoryRunIds(
    client,
    input.userId,
    runIds
  );
  if (personalRunIds.size === 0) return new Map();
  const attempts = await client.memoryRetrievalAttempt.findMany({
    orderBy: [{ modelRunId: "asc" }, { attemptOrdinal: "desc" }],
    select: { budgetSnapshot: true, modelRunId: true },
    where: {
      modelRunId: { in: [...personalRunIds] },
      state: "CONSUMED",
      userId: input.userId
    }
  });
  const candidates = new Map<string, PersistedMemoryActionFeedback>();
  for (const attempt of attempts) {
    if (candidates.has(attempt.modelRunId)) continue;
    const candidate = record(attempt.budgetSnapshot)?.memoryActionResult;
    const decoded = decodePersistedMemoryActionFeedback(candidate);
    if (decoded.ok) candidates.set(attempt.modelRunId, decoded.value);
  }
  const refs = input.clientRefs ?? defaultMemoryClientRefService;
  const now = input.now ?? new Date();
  const resolved = new Map<string, MemoryClientRefPayload>();
  const refEntries: Array<Readonly<{ memoryRef: string; runId: string }>> = [];
  for (const [runId, candidate] of candidates) {
    if (candidate.memoryRef) refEntries.push({ memoryRef: candidate.memoryRef, runId });
    for (const item of candidate.items ?? candidate.candidates ?? []) {
      refEntries.push({ memoryRef: item.memoryRef, runId });
    }
  }
  for (const entry of refEntries) {
    const payload = refs.resolve(input.userId, entry.memoryRef, "EDIT", now);
    if (
      payload?.originatingRunId === entry.runId &&
      payload.target.itemType === "FACT_VERSION" &&
      payload.target.factId &&
      payload.target.factVersionId
    ) {
      resolved.set(`${entry.runId}\u0000${entry.memoryRef}`, payload);
    }
  }
  const factIds = [...new Set([...resolved.values()].flatMap((payload) =>
    payload.target.factId ? [payload.target.factId] : []))];
  const versionIds = [...new Set([...resolved.values()].flatMap((payload) =>
    payload.target.factVersionId ? [payload.target.factVersionId] : []))];
  const [facts, versions] = await Promise.all([
    factIds.length > 0
      ? client.memoryFact.findMany({
          select: { currentVersionId: true, id: true, scopeId: true, state: true },
          where: { id: { in: factIds }, userId: input.userId }
        })
      : Promise.resolve([]),
    versionIds.length > 0
      ? client.memoryFactVersion.findMany({
          select: {
            contentPurgedAt: true,
            displayText: true,
            factId: true,
            id: true,
            safetyClassificationState: true,
            sensitivityClass: true,
            state: true
          },
          where: { id: { in: versionIds }, userId: input.userId }
        })
      : Promise.resolve([])
  ]);
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const versionsById = new Map(versions.map((version) => [version.id, version]));
  const eligibleVersionIds = await loadPersonalEligibleFactVersionIds(
    client,
    input.userId,
    versionIds
  );
  const canonicalScopeIds = new Set(facts.length > 0
    ? (await client.memoryScope.findMany({
        select: { id: true },
        where: {
          ...canonicalGlobalMemoryScopeWhere(),
          id: { in: [...new Set(facts.map(({ scopeId }) => scopeId))] },
          userId: input.userId
        }
      })).map(({ id }) => id)
    : []);

  function currentItem(
    runId: string,
    item: Pick<MemoryActionResultItem, "memoryRef" | "statement">
  ): boolean {
    const payload = resolved.get(`${runId}\u0000${item.memoryRef}`);
    const factId = payload?.target.factId;
    const versionId = payload?.target.factVersionId;
    if (!factId || !versionId) return false;
    const fact = factsById.get(factId);
    const version = versionsById.get(versionId);
    return Boolean(
      fact && version && version.factId === fact.id &&
      eligibleVersionIds.has(version.id) &&
      canonicalScopeIds.has(fact.scopeId) &&
      fact.state === "ACTIVE" && fact.currentVersionId === version.id &&
      version.state === "ACTIVE" && version.contentPurgedAt === null &&
      version.safetyClassificationState === "CLASSIFIED" &&
      (version.sensitivityClass === "NORMAL" || version.sensitivityClass === "SENSITIVE") &&
      version.displayText === item.statement
    );
  }

  const projected = new Map<string, MemoryActionFeedback>();
  for (const [runId, candidate] of candidates) {
    if (candidate.status === "COMMITTED" && candidate.operation === "FORGET") {
      projected.set(runId, { operation: "FORGET", status: "COMMITTED" });
      continue;
    }
    if (
      candidate.status === "COMMITTED" &&
      (candidate.operation === "SAVE" || candidate.operation === "UPDATE") &&
      candidate.memoryRef && candidate.statement &&
      currentItem(runId, {
        memoryRef: candidate.memoryRef,
        statement: candidate.statement
      })
    ) {
      projected.set(runId, candidate);
      continue;
    }
    if (candidate.status === "COMPLETE" && candidate.items) {
      projected.set(runId, {
        items: candidate.items.filter((item) => currentItem(runId, item)),
        operation: candidate.operation,
        status: "COMPLETE"
      });
      continue;
    }
    if (candidate.status === "AMBIGUOUS" && candidate.candidates) {
      const current = candidate.candidates.filter((item) => currentItem(runId, item));
      if (current.length >= 2) {
        projected.set(runId, {
          candidates: current,
          operation: candidate.operation,
          ...(candidate.operation === "UPDATE" && candidate.statement
            ? { statement: candidate.statement }
            : {}),
          status: "AMBIGUOUS"
        });
      }
      continue;
    }
    if (candidate.status === "REJECTED") {
      projected.set(runId, { operation: candidate.operation, status: "REJECTED" });
      continue;
    }
    if (
      candidate.status === "THIS_CHAT_ONLY" &&
      candidate.operation === "SAVE" &&
      candidate.statement
    ) {
      projected.set(runId, {
        operation: "SAVE",
        statement: candidate.statement,
        status: "THIS_CHAT_ONLY"
      });
      continue;
    }
    if (candidate.status === "CONFIRMATION_REQUIRED" && candidate.operation === "RESET") {
      projected.set(runId, { operation: "RESET", status: "CONFIRMATION_REQUIRED" });
    }
  }
  return projected;
}
