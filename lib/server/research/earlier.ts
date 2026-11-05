import type { PrismaClient } from "@prisma/client";
import { decodeResearchFrame, RESEARCH_RECORD_KINDS, type ResearchDraft, type ResearchFrame, type ResearchRecordKind } from "../../contracts/research";
import { logEvent } from "../observability";
import type { ResearchEarlierOption } from "./candidates";
import type { ResearchEarlierPort, ResearchEarlierRead, ResearchEarlierRecord, ResearchRunScope } from "./ports";

/**
 * What a new research starts with of earlier research on its branch (`agent_docs/RUN_CONTRACTS.md`, Research). In a real chat the first run's best option
 * fitted the budget of a second research the user started, which never named it, and the user was not told. So at the start the server takes the options
 * each earlier research recommended, its pick and its summary's rows, and seeds them as candidates (`candidates.ts`), each with its page and the date its
 * records were made.
 *
 * Which researches: those the branch's own items finished, read by `researchEarlierDrafts` (`run.ts`) from each turn's accepted draft, the same reading an
 * approval continuation and a Continue make of their turn. The items are the active branch's ancestors only, as context is, so a sibling branch's research
 * is never among them. The run and record ids they name are stored values: this port counts a run only when it is one of `branchRunIds`, and reads only
 * this user's rows of this chat, so nothing names another user's, another chat's or another branch's research into a new one.
 *
 * What it reads: the released frame of each such research run, for its rows' names, and the records its accepted draft cited, for each option's page and
 * date. Nothing is linked: a new research has its own frame and records, and the earlier records prove nothing in it (no `continuedFromRunId`).
 */

/** How many cited records one start looks up: a few researches' drafts, each citing what its rows rest on. */
const RECORD_IDS = 2_000;

export type ResearchEarlierKey = Readonly<{ chatId: string; userId: string }>;

export type ResearchEarlierStore = Readonly<{
  /** The frames of these runs whose plan was released, this user's in this chat only. */
  frames(key: ResearchEarlierKey, runIds: readonly string[]): Promise<readonly Readonly<{ frame: unknown; runId: string }>[]>;
  /** These records under these runs, this user's in this chat only. */
  records(key: ResearchEarlierKey, input: Readonly<{ ids: readonly string[]; runIds: readonly string[] }>): Promise<readonly ResearchEarlierRecord[]>;
}>;

const isRecordKind = (value: string): value is ResearchRecordKind => (RESEARCH_RECORD_KINDS as readonly string[]).includes(value);

export function createResearchEarlierStore(client: Pick<PrismaClient, "researchEvidence" | "researchFrame">): ResearchEarlierStore {
  return {
    async frames({ chatId, userId }, runIds) {
      const rows = await client.researchFrame.findMany({ select: { frame: true, modelRunId: true },
        where: { chatId, modelRunId: { in: [...runIds] }, releasedAt: { not: null }, userId } });
      return rows.map(({ frame, modelRunId }) => ({ frame, runId: modelRunId }));
    },
    async records({ chatId, userId }, { ids, runIds }) {
      const rows = await client.researchEvidence.findMany({ select: { createdAt: true, id: true, kind: true, modelRunId: true, rowKey: true, url: true },
        where: { chatId, id: { in: [...ids] }, modelRunId: { in: [...runIds] }, userId } });
      return rows.flatMap((row) => isRecordKind(row.kind)
        ? [{ createdAt: row.createdAt.toISOString(), id: row.id, kind: row.kind, rowKey: row.rowKey, runId: row.modelRunId, url: row.url }] : []);
    }
  };
}

const NOTHING: ResearchEarlierRead = { frames: new Map(), records: [] };

/** One port per run (`ResearchPortFactories.earlier`). */
export function createResearchEarlier(deps: Readonly<{ store: ResearchEarlierStore }>) {
  return (run: ResearchRunScope): ResearchEarlierPort => ({
    async read({ recordIds, researchRunIds }, signal) {
      signal.throwIfAborted();
      const key = { chatId: run.chatId, userId: run.userId };
      // Stored values: only the branch's earlier runs count, never this run's own.
      const earlierRuns = run.branchRunIds.filter((runId) => runId !== run.runId);
      const runs = [...new Set(researchRunIds)].filter((runId) => earlierRuns.includes(runId));
      if (runs.length === 0) return NOTHING;
      const frames = new Map<string, ResearchFrame>();
      for (const row of await deps.store.frames(key, runs)) {
        const decoded = decodeResearchFrame(row.frame);
        if (decoded.ok) frames.set(row.runId, decoded.value);
        else logEvent("service_operation", { action: "degrade", code: "research_earlier_frame_invalid", outcome: "degraded", run_id: run.runId, stage: "read", subsystem: "database" });
      }
      const ids = [...new Set(recordIds)].slice(0, RECORD_IDS);
      if (frames.size === 0 || ids.length === 0) return { frames, records: [] };
      signal.throwIfAborted();
      // A cited record may be under an earlier run of the same research, one a Continue picked up, which is on the branch too.
      return { frames, records: await deps.store.records(key, { ids, runIds: earlierRuns }) };
    }
  });
}

/** A research an earlier turn of the branch finished: its accepted draft and the run its rows are kept under. */
export type ResearchEarlierDraft = Readonly<{ draft: ResearchDraft; researchRunId: string }>;

/** The rows a draft recommends, in its order: the pick, the summary's rows, each case's pick. */
const recommendedRows = (draft: ResearchDraft) =>
  [...new Set([...draft.pickRowKey ? [draft.pickRowKey] : [], ...draft.summary?.rowKeys ?? [], ...draft.branchPicks?.map(({ rowKey }) => rowKey) ?? []])];

const newestFirst = (one: ResearchEarlierRecord, other: ResearchEarlierRecord) => other.createdAt < one.createdAt ? -1 : other.createdAt > one.createdAt ? 1 : 0;

/**
 * The options earlier research recommended, newest research first and each one's pick first: a row's name from its frame, and from the records its draft
 * cited for that row the newest page and its date. A row with no cited record of its own takes the date of the newest record the draft cited and no
 * page; a draft that cited none gives no option, since there is no date to give it. Duplicates are left to `researchEarlierCandidates`.
 */
export function researchEarlierOptions(researches: readonly ResearchEarlierDraft[], read: ResearchEarlierRead): readonly ResearchEarlierOption[] {
  const records = new Map(read.records.map((record) => [record.id, record]));
  const options: ResearchEarlierOption[] = [];
  for (const { draft, researchRunId } of researches) {
    const frame = read.frames.get(researchRunId);
    if (!frame) continue;
    const cited = [...new Set(draft.recordIds ?? [])].flatMap((id) => records.get(id) ?? []).sort(newestFirst);
    const [newest] = cited;
    if (!newest) continue;
    for (const key of recommendedRows(draft)) {
      const row = frame.rows.find((entry) => entry.key === key);
      if (!row) continue;
      const page = cited.find((record) => record.rowKey === key && (record.kind === "finding" || record.kind === "dataset") && record.url !== null);
      options.push({ label: row.label, on: (page ?? newest).createdAt.slice(0, 10), pick: key === draft.pickRowKey, url: page?.url ?? null });
    }
  }
  return options;
}
