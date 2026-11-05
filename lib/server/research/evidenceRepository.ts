import { createHash } from "node:crypto";
import { Prisma, type PrismaClient, type ResearchEvidence, type ResearchPage } from "@prisma/client";
import {
  decodeResearchRecord,
  RESEARCH_EVIDENCE_LIMITS,
  RESEARCH_PAGE_LIMITS,
  type ResearchAgentRef,
  type ResearchDataset,
  type ResearchEvidenceRecord,
  type ResearchPageOrigin,
  type ResearchQuoteCheckStatus,
  type ResearchRecordInput,
  type ResearchStoredPage
} from "../../contracts/research";
import { json } from "../runs/prismaRepositoryShared";
import { FETCH_URL_TOOL_NAME } from "../tools/fetchUrlPlan";
import { fetchUrlDigest, normalizeFetchUrl } from "../webFetch/urls";
import type { ResearchEvidenceWritten } from "./ports";
import type { ResearchAgentCall, ResearchAgentCalls, ResearchAgentScope } from "./sources";
import { researchTextGroupKey, type ResearchSourceQuality } from "./sourceQuality";

/**
 * The evidence store's rows (`ResearchEvidence`, `ResearchPage`) and the read of an agent's own results. Parallel researchers write
 * at once, so a write takes a lock per research run in its transaction: `sequence` and the bounds hold under it. The lock is held
 * only over this database: whatever a write reads of an agent's results was read before it opens. Every query names the owner and
 * the chat, and nothing here changes or deletes a row.
 */
export type ResearchEvidenceScope = Readonly<{ chatId: string; researchRunId: string; userId: string }>;

/** What a quote check says of a record. */
export type ResearchRecordedCheck = NonNullable<ResearchEvidenceRecord["quoteCheck"]>;

export type ResearchPageWrite = Readonly<{ obtainedBy: ResearchPageOrigin; text: string; truncated: boolean; url: string }>;

export type ResearchEvidenceAppend = Readonly<{
  author: ResearchAgentRef;
  /** The runs of this research, which is what a correction may name. */
  chain: readonly string[];
  /** Bounded already: a page the run's bounds have no room for is left out, and the write says so through `quoteCheck`. */
  page: ResearchPageWrite | null;
  /** The check's word with the page kept, and without it. */
  quoteCheck: Readonly<{ kept: ResearchRecordedCheck | null; notKept: ResearchRecordedCheck | null }>;
  record: ResearchRecordInput;
  sourceQuality: ResearchSourceQuality;
}>;

/** A row no writer here could have made. It fails the read, as a transcript's does (`transcriptCodec.ts`), rather than dropping a record unseen. */
class ResearchEvidenceRowError extends Error {
  override name = "ResearchEvidenceRowError";

  constructor() {
    super("research_evidence_row_invalid");
  }
}

/** Waiting writers hold a connection, so they wait in bounded time; each holds the lock for a few statements. */
const APPEND_TRANSACTION = Object.freeze({ maxWait: 10_000, timeout: 30_000 });

const refused = (code: string, message: string): ResearchEvidenceWritten => ({ code, kind: "refused", message });

const RECORDS_FULL = () => refused("research_records_full",
  `Nothing was recorded: this research holds its ${RESEARCH_EVIDENCE_LIMITS.recordsPerRun} records. Put what you have in your report.`);
const RECORD_UNKNOWN = () => refused("research_record_unknown", "Nothing was recorded: supersedes names no record of this research.");
const RECORD_CORRECTED = () => refused("research_record_corrected",
  "Nothing was recorded: that record already has its correction. Correct that one, or record this as a new finding with supersedes null.");

async function lockResearchEvidence(tx: Prisma.TransactionClient, researchRunId: string): Promise<void> {
  await tx.$queryRaw<Array<{ lock: string }>>(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`aiqsa:research-evidence:${researchRunId}`}, 0))::text AS "lock"
  `);
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** A dataset in its tool's form, which is how a row keeps it: `decodeResearchRecord` reads both. */
function datasetDocument(dataset: ResearchDataset) {
  return { counts: dataset.counts, examples: dataset.examples, left_out: dataset.leftOut, method: dataset.method, sample_size: dataset.sampleSize };
}

/** The columns of a record, each kind's own and nothing else (`ResearchEvidence_shape_check`). */
function recordColumns(record: ResearchRecordInput) {
  const base = { criterionKey: record.criterionKey, kind: record.kind, rowKey: record.rowKey, supersedesId: record.supersedes };
  switch (record.kind) {
    case "finding":
      return { ...base, claim: record.claim, quote: record.quote, sourceClass: record.sourceClass, standing: record.standing, url: record.url };
    case "not_found":
      return { ...base, reason: record.reason, sourceClass: record.sourceClass };
    case "dataset":
      return { ...base, claim: record.claim, dataset: json(datasetDocument(record.dataset)), sourceClass: record.sourceClass, standing: record.standing, url: record.url };
    case "unreachable":
      return { ...base, reason: record.reason, sourceClass: record.sourceClass, target: record.target };
  }
}

function recordOf(row: ResearchEvidence): ResearchEvidenceRecord {
  const decoded = decodeResearchRecord({ claim: row.claim, criterion_key: row.criterionKey, dataset: row.dataset, kind: row.kind, quote: row.quote, reason: row.reason,
    row_key: row.rowKey, source_class: row.sourceClass, standing: row.standing, supersedes: row.supersedesId, target: row.target, url: row.url });
  if (!decoded.ok) throw new ResearchEvidenceRowError();
  return { ...decoded.value, author: { name: row.authorName, threadId: row.authorThreadId }, createdAt: row.createdAt.toISOString(), id: row.id, pageId: row.pageId,
    publishedOn: row.publishedOn, quoteCheck: row.quoteCheck ? { reason: row.quoteCheckReason, status: row.quoteCheck as ResearchQuoteCheckStatus } : null,
    registrableDomain: row.registrableDomain, runId: row.modelRunId, sequence: row.sequence, textGroupKey: row.textGroupKey };
}

function pageOf(row: ResearchPage): ResearchStoredPage {
  return { capturedAt: row.capturedAt.toISOString(), contentHash: row.contentHash, id: row.id, obtainedBy: row.obtainedBy as ResearchPageOrigin, sizeBytes: row.sizeBytes,
    text: row.text, truncated: row.truncated, url: row.url };
}

/** The stored page of this text at this link, kept once however many agents read it; null when the run's bounds leave no room for it. */
async function keptPage(tx: Prisma.TransactionClient, keys: Readonly<{ chatId: string; modelRunId: string; userId: string }>, page: ResearchPageWrite): Promise<string | null> {
  const contentHash = sha256(page.text);
  const linkHash = fetchUrlDigest(normalizeFetchUrl(page.url) ?? page.url);
  const same = await tx.researchPage.findFirst({ select: { id: true }, where: { ...keys, contentHash, linkHash } });
  if (same) return same.id;
  const sizeBytes = Buffer.byteLength(page.text);
  const held = await tx.researchPage.aggregate({ _count: { _all: true }, _sum: { sizeBytes: true }, where: keys });
  if (held._count._all >= RESEARCH_PAGE_LIMITS.pagesPerRun || (held._sum.sizeBytes ?? 0) + sizeBytes > RESEARCH_PAGE_LIMITS.bytesPerRun) return null;
  const created = await tx.researchPage.create({ data: { ...keys, contentHash, linkHash, obtainedBy: page.obtainedBy, sizeBytes, text: page.text, truncated: page.truncated,
    url: page.url }, select: { id: true } });
  return created.id;
}

const CALL_SELECT = { arguments: true, id: true, observation: { select: { id: true } }, providerCallId: true, result: true, toolName: true } as const;

function callOf({ observation, ...row }: Prisma.ModelRunToolCallGetPayload<{ select: typeof CALL_SELECT }>): ResearchAgentCall {
  return { ...row, observationId: observation?.id ?? null };
}

type EvidenceClient = Pick<PrismaClient, "$transaction" | "modelRunToolCall" | "researchEvidence" | "researchFrame" | "researchPage">;

export function createResearchEvidenceRepository(client: EvidenceClient) {
  return {
    /**
     * Appends one record under the research run, with its page, in order and within the bounds. A limit or a bad reference refuses and
     * writes nothing; a page with no room leaves the record without it.
     */
    async append(scope: ResearchEvidenceScope, write: ResearchEvidenceAppend): Promise<ResearchEvidenceWritten> {
      const keys = { chatId: scope.chatId, modelRunId: scope.researchRunId, userId: scope.userId };
      const supersedes = write.record.supersedes;
      try {
        return await client.$transaction(async (tx): Promise<ResearchEvidenceWritten> => {
          await lockResearchEvidence(tx, scope.researchRunId);
          const taken = await tx.researchEvidence.aggregate({ _count: { _all: true }, _max: { sequence: true }, where: keys });
          if (taken._count._all >= RESEARCH_EVIDENCE_LIMITS.recordsPerRun) return RECORDS_FULL();
          if (supersedes !== null) {
            const earlier = await tx.researchEvidence.findFirst({ select: { supersededBy: { select: { id: true } } },
              where: { chatId: scope.chatId, id: supersedes, modelRunId: { in: [...write.chain] }, userId: scope.userId } });
            if (!earlier) return RECORD_UNKNOWN();
            if (earlier.supersededBy) return RECORD_CORRECTED();
          }
          const pageId = write.page ? await keptPage(tx, keys, write.page) : null;
          const check = write.page && !pageId ? write.quoteCheck.notKept : write.quoteCheck.kept;
          const quality = write.sourceQuality;
          const earlier = quality.textGroupKey !== null ? await tx.researchEvidence.findMany({
            distinct: ["textGroupKey"], orderBy: [{ createdAt: "asc" }, { sequence: "asc" }, { id: "asc" }], select: { textGroupKey: true }, take: RESEARCH_PAGE_LIMITS.pagesPerRun,
            where: { chatId: scope.chatId, modelRunId: { in: [...write.chain] }, textGroupKey: { not: null }, userId: scope.userId }
          }) : [];
          const row = await tx.researchEvidence.create({ data: { ...keys, ...recordColumns(write.record), authorName: write.author.name, authorThreadId: write.author.threadId,
            publishedOn: quality.publishedOn, registrableDomain: quality.registrableDomain,
            textGroupKey: researchTextGroupKey(quality.textGroupKey, earlier.map((entry) => entry.textGroupKey)),
            pageId, quoteCheck: check?.status ?? null, quoteCheckReason: check?.reason ?? null, sequence: (taken._max.sequence ?? -1) + 1 } });
          return { kind: "recorded", record: recordOf(row) };
        }, APPEND_TRANSACTION);
      } catch (error) {
        // The lock is this research's: another branch's Continue may have corrected the same earlier record, and the key keeps that to one.
        if (supersedes !== null && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return RECORD_CORRECTED();
        throw error;
      }
    },

    /**
     * The runs of this research, earliest first: its own and, walking `ResearchFrame.continuedFromRunId`, those it continues. A run
     * with no frame row reads its own alone, and the bound means the walk can never loop.
     */
    async chain(scope: ResearchEvidenceScope): Promise<readonly string[]> {
      const runs = [scope.researchRunId];
      for (let hop = 0; hop < RESEARCH_EVIDENCE_LIMITS.continuationChain; hop += 1) {
        const frame = await client.researchFrame.findFirst({ select: { continuedFromRunId: true },
          where: { chatId: scope.chatId, modelRunId: runs[0]!, userId: scope.userId } });
        const earlier = frame?.continuedFromRunId;
        if (!earlier || runs.includes(earlier)) break;
        runs.unshift(earlier);
      }
      return runs;
    },

    /** The stored page under these runs; null for any other id, the same as for one that does not exist. */
    async page(scope: ResearchEvidenceScope, runIds: readonly string[], pageId: string): Promise<ResearchStoredPage | null> {
      const row = await client.researchPage.findFirst({ where: { chatId: scope.chatId, id: pageId, modelRunId: { in: [...runIds] }, userId: scope.userId } });
      return row && pageOf(row);
    },

    /**
     * The live records under these runs, run by run in the order given, each in its order. What makes one no longer live is a correction
     * among these runs: another branch's Continue may have corrected an earlier run's record, which stands here.
     */
    async records(scope: ResearchEvidenceScope, runIds: readonly string[]): Promise<readonly ResearchEvidenceRecord[]> {
      const rows = await client.researchEvidence.findMany({ where: { chatId: scope.chatId, modelRunId: { in: [...runIds] }, userId: scope.userId } });
      const corrected = new Set(rows.flatMap((row) => row.supersedesId ?? []));
      return rows.filter((row) => !corrected.has(row.id))
        .sort((one, other) => runIds.indexOf(one.modelRunId) - runIds.indexOf(other.modelRunId) || one.sequence - other.sequence).map(recordOf);
    },

    /**
     * Every record under these runs that corrects another, live or not, to the one it corrects: how a check follows a correction of a correction back to what
     * it rejected, since `records` holds only the live end of the chain.
     */
    async supersessions(scope: ResearchEvidenceScope, runIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
      const rows = await client.researchEvidence.findMany({ select: { id: true, supersedesId: true }, where: { chatId: scope.chatId, modelRunId: { in: [...runIds] }, userId: scope.userId } });
      return new Map(rows.flatMap(({ id, supersedesId }) => supersedesId === null ? [] : [[id, supersedesId] as const]));
    },

    /** What a write reads of one agent's own calls, through the owner and chat of its research. */
    agentCalls(scope: Pick<ResearchEvidenceScope, "chatId" | "userId">): ResearchAgentCalls {
      const own = (agent: ResearchAgentScope) => ({ modelRun: { chatId: scope.chatId, userId: scope.userId }, modelRunId: { in: [...agent.runIds] },
        state: "complete" as const, subagentThreadId: agent.threadId });
      const newest: Prisma.ModelRunToolCallOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "desc" }];
      return {
        async attempts(agent, { limit, toolNames }) {
          const rows = await client.modelRunToolCall.findMany({ orderBy: newest, select: CALL_SELECT, take: limit,
            where: { ...own(agent), state: { in: ["complete", "error"] }, toolName: { in: [...toolNames] } } });
          return rows.map(callOf);
        },
        async calls(agent, ids) {
          const rows = await client.modelRunToolCall.findMany({ select: CALL_SELECT, where: { ...own(agent), id: { in: [...ids] } } });
          return rows.sort((one, other) => ids.indexOf(one.id) - ids.indexOf(other.id)).map(callOf);
        },
        fetchCalls: (agent, limit) => client.modelRunToolCall.findMany({ orderBy: newest, select: { arguments: true, id: true }, take: limit,
          where: { ...own(agent), toolName: FETCH_URL_TOOL_NAME } }),
        async recentCalls(agent, { excludedTools, limit }) {
          const rows = await client.modelRunToolCall.findMany({ orderBy: newest, select: CALL_SELECT, take: limit,
            where: { ...own(agent), toolName: { notIn: [...excludedTools] } } });
          return rows.map(callOf);
        }
      };
    }
  };
}

export type ResearchEvidenceRepository = ReturnType<typeof createResearchEvidenceRepository>;
