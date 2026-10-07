import { createHash } from "node:crypto";
import { Prisma, type PrismaClient, type WorkspaceSessionState } from "@prisma/client";
import { SCHEDULED_TASK_WORKSPACE_CAPACITY_CODE } from "@/lib/contracts/scheduledTasks";
import {
  WORKSPACE_OVERVIEW_PAGE_SIZE,
  type WorkspaceOverviewFilter,
  type WorkspaceOverviewFootprint,
  type WorkspaceOverviewRow,
  type WorkspaceOverviewState,
  type WorkspaceOverviewWire
} from "@/lib/contracts/workspaceOverview";
import { workspaceDiskPinnedByScheduledTaskSql } from "./cleanup";
import { WORKSPACE_RUNTIME_INVENTORY_PAGE_SIZE, type WorkspaceRuntime, type WorkspaceRuntimeInventoryPage } from "./runtime";

const MAX_SESSIONS = 10_000;
const MAX_RUNTIME_PAGES = MAX_SESSIONS / WORKSPACE_RUNTIME_INVENTORY_PAGE_SIZE;
type Observation = WorkspaceRuntimeInventoryPage["entries"][number];
export type WorkspaceOverviewRecord = Readonly<{
  context: "personal" | "project";
  id: string;
  lastActiveAt: Date;
  runtimeSandboxId: string | null;
  sandboxName: string;
  state: WorkspaceSessionState;
  user: string | null;
}>;
export type WorkspaceOverviewRepository = Readonly<{
  read(): Promise<readonly WorkspaceOverviewRecord[]>;
  /** Content-free disk and scheduled capacity counts at `now`; absent where they are not kept. */
  footprint?(now: Date): Promise<WorkspaceOverviewFootprint>;
}>;

/** The window of the scheduled capacity counts. */
const FOOTPRINT_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * `retentionSeconds` (the Workspace configuration's) adds the footprint
 * counts: the disk pin they share with cleanup is measured against it.
 */
export function createPrismaWorkspaceOverviewRepository(
  prisma: Pick<PrismaClient, "$queryRaw" | "workspaceSession">,
  options: Readonly<{ retentionSeconds?: number }> = {}
): WorkspaceOverviewRepository {
  const retentionSeconds = options.retentionSeconds;
  return {
    ...(retentionSeconds !== undefined ? {
      async footprint(now: Date): Promise<WorkspaceOverviewFootprint> {
        const pinnedAfter = new Date(now.getTime() - retentionSeconds * 1_000);
        const since = new Date(now.getTime() - FOOTPRINT_WINDOW_MS);
        // A disk exists once its environment was created, until deletion starts.
        const [row] = await prisma.$queryRaw<WorkspaceOverviewFootprint[]>(Prisma.sql`
          SELECT
            count(*)::int AS "retainedDisks",
            count(*) FILTER (WHERE ${workspaceDiskPinnedByScheduledTaskSql(Prisma.sql`ws."chatId"`, pinnedAfter)})::int
              AS "scheduledDisks",
            (SELECT count(*) FROM "ScheduledTaskOccurrence" AS occurrence
              WHERE occurrence."workspaceWaitStartedAt" >= ${since})::int AS "scheduledWaits",
            (SELECT count(*) FROM "ScheduledTaskOccurrence" AS occurrence
              WHERE occurrence."state" = 'SKIPPED'::"ScheduledTaskOccurrenceState"
                AND occurrence."reasonCode" = ${SCHEDULED_TASK_WORKSPACE_CAPACITY_CODE} AND occurrence."finishedAt" >= ${since})::int AS "scheduledSkips"
          FROM "WorkspaceSession" AS ws
          WHERE ws."state" <> 'DELETING'::"WorkspaceSessionState"
            AND (ws."state" <> 'PENDING'::"WorkspaceSessionState" OR ws."runtimeSandboxId" IS NOT NULL)
        `);
        return row ?? { retainedDisks: 0, scheduledDisks: 0, scheduledSkips: 0, scheduledWaits: 0 };
      }
    } : {}),
    async read() {
      const records = await prisma.workspaceSession.findMany({
        orderBy: { id: "asc" },
        select: {
          chat: { select: {
            createdBy: { select: { displayName: true } }, createdByDisplayName: true, projectId: true,
            user: { select: { displayName: true } }
          } },
          id: true, lastActiveAt: true, runtimeSandboxId: true, sandboxName: true, state: true
        },
        take: MAX_SESSIONS + 1
      });
      // Never turn a safety limit into a plausible partial total.
      if (records.length > MAX_SESSIONS) throw new Error("workspace_overview_limit_exceeded");
      return records.map((record) => ({
        context: record.chat.projectId ? "project" as const : "personal" as const,
        id: record.id, lastActiveAt: record.lastActiveAt, runtimeSandboxId: record.runtimeSandboxId,
        sandboxName: record.sandboxName, state: record.state,
        user: record.chat.projectId
          ? record.chat.createdBy?.displayName ?? (record.chat.createdByDisplayName || null)
          : record.chat.user?.displayName ?? null
      }));
    }
  };
}

type Snapshot = Readonly<{
  activeCount: number | null;
  footprint: WorkspaceOverviewFootprint | null;
  observedAt: string | null;
  rows: readonly WorkspaceOverviewRow[];
  state: WorkspaceOverviewWire["state"];
  stoppedCount: number | null;
  updatedAt: string;
}>;

function rowId(kind: "session" | "runtime", id: string): string {
  return `ws-${createHash("sha256").update(`workspace-admin\0${kind}\0${id}`).digest("hex").slice(0, 16)}`;
}
function rowState(record: WorkspaceOverviewRecord | null, observed: Observation | undefined): WorkspaceOverviewState {
  if (!observed) return record?.state === "PENDING" && record.runtimeSandboxId === null ? "not_started" : "unknown";
  if (observed.state === "starting") return "starting";
  if (observed.state === "draining") return "stopping";
  if (observed.state === "paused") return "paused";
  // CREATING also covers exports and idle stop. It does not prove VM startup.
  if (record?.state === "CREATING" || record?.state === "DELETING") return "changing";
  if (observed.state === "running") {
    if (record?.state === "RUNNING") return "running";
    return !record || record.state === "READY" ? "ready" : "unknown";
  }
  return observed.state === "created" ? "not_started" : "stopped";
}

function project(
  records: readonly WorkspaceOverviewRecord[],
  observations: readonly Observation[] | null,
  now: number,
  footprint: WorkspaceOverviewFootprint | null
): Snapshot {
  const byId = new Map(observations?.map((entry) => [entry.runtimeSandboxId, entry]));
  const byName = new Map(observations?.map((entry) => [entry.sandboxName, entry]));
  const used = new Set<string>();
  const rows: WorkspaceOverviewRow[] = records.map((record) => {
    // A same-name replacement cannot stand in for a known durable identity.
    const observed = record.runtimeSandboxId ? byId.get(record.runtimeSandboxId) : byName.get(record.sandboxName);
    if (observed) used.add(observed.runtimeSandboxId);
    const user = record.user?.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 160) || null;
    return { context: record.context, id: rowId("session", record.id), lastActiveAt: record.lastActiveAt.toISOString(),
      state: rowState(record, observed), user };
  });
  for (const entry of observations ?? []) {
    if (used.has(entry.runtimeSandboxId)) continue;
    rows.push({ context: null, id: rowId("runtime", entry.runtimeSandboxId), lastActiveAt: null, state: rowState(null, entry), user: null });
  }
  rows.sort((a, b) => (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? "") || a.id.localeCompare(b.id));
  return {
    // Draining and paused VMs still exist in memory. Transitions are a separate,
    // potentially overlapping count, not an addend to this observation.
    activeCount: observations?.filter((entry) => ["running", "draining", "paused"].includes(entry.state)).length ?? null,
    footprint,
    observedAt: observations ? new Date(now).toISOString() : null,
    rows,
    state: observations ? "fresh" : "unavailable",
    stoppedCount: observations?.filter((entry) => entry.state === "stopped" || entry.state === "crashed").length ?? null,
    updatedAt: new Date(now).toISOString()
  };
}

export function createWorkspaceOverviewService(input: Readonly<{
  cacheTtlMs?: number;
  now?: () => number;
  repository: WorkspaceOverviewRepository;
  runtime: Pick<WorkspaceRuntime, "listSessions">;
  timeoutMs?: number;
}>) {
  const now = input.now ?? Date.now;
  const timeoutMs = input.timeoutMs ?? 5_000;
  let cached: { expiresAt: number; value: Snapshot } | null = null;
  let lastGood: Snapshot | null = null;
  let pending: Promise<Snapshot> | null = null;

  async function observe(signal: AbortSignal): Promise<readonly Observation[]> {
    if (!input.runtime.listSessions) throw new Error("workspace_inventory_unavailable");
    const entries: Observation[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < MAX_RUNTIME_PAGES; pageNumber += 1) {
      signal.throwIfAborted();
      const page = await input.runtime.listSessions({ ...(cursor ? { cursor } : {}), signal });
      signal.throwIfAborted();
      if (page.entries.length > WORKSPACE_RUNTIME_INVENTORY_PAGE_SIZE) throw new Error("workspace_inventory_invalid");
      for (const entry of page.entries) {
        if (ids.has(entry.runtimeSandboxId)) throw new Error("workspace_inventory_changed");
        ids.add(entry.runtimeSandboxId);
        entries.push(entry);
      }
      if (!page.nextCursor) return entries;
      if (cursors.has(page.nextCursor)) throw new Error("workspace_inventory_invalid");
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error("workspace_overview_limit_exceeded");
  }

  function unavailable(): Snapshot {
    return lastGood
      ? { ...lastGood, state: "stale", updatedAt: new Date(now()).toISOString() }
      : project([], null, now(), null);
  }

  async function snapshot(): Promise<Snapshot> {
    if (cached && cached.expiresAt > now()) return cached.value;
    if (!pending) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      // Retain the shared pending operation until its actual I/O settles, even
      // when a caller times out; a stuck SDK must not create overlapping scans.
      pending = Promise.allSettled([input.repository.read(), observe(controller.signal),
        input.repository.footprint ? input.repository.footprint(new Date(now())) : Promise.resolve(null)])
        .then(([database, runtime, counts]) => {
          if (database.status === "rejected") throw new Error("workspace_overview_unavailable");
          const records = database.value;
          const observations = runtime.status === "fulfilled" ? runtime.value : null;
          // The counts are a separate read: their failure leaves them unknown, never the activity.
          const footprint = counts.status === "fulfilled" ? counts.value : null;
          const value = observations === null && lastGood
            ? unavailable() : project(records, observations, now(), footprint);
          if (value.state === "fresh") lastGood = value;
          cached = { expiresAt: now() + (input.cacheTtlMs ?? 5_000), value };
          return value;
        }).catch(() => {
          const value = unavailable();
          cached = { expiresAt: now() + (input.cacheTtlMs ?? 5_000), value };
          return value;
        }).finally(() => { clearTimeout(timer); pending = null; });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([pending, new Promise<Snapshot>((resolve) => {
        timer = setTimeout(() => resolve(unavailable()), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  return {
    async read(options: Readonly<{ filter: WorkspaceOverviewFilter; page: number }>): Promise<WorkspaceOverviewWire> {
      const value = await snapshot();
      // Filter the complete observation before counting and selecting a page.
      const rows = options.filter === "all" ? value.rows
        : value.rows.filter((row) => row.state !== "stopped" && row.state !== "not_started");
      const page = Math.min(options.page, Math.max(1, Math.ceil(rows.length / WORKSPACE_OVERVIEW_PAGE_SIZE)));
      return {
        activeCount: value.activeCount, filter: options.filter, footprint: value.footprint, observedAt: value.observedAt, page,
        pageSize: WORKSPACE_OVERVIEW_PAGE_SIZE,
        rows: rows.slice((page - 1) * WORKSPACE_OVERVIEW_PAGE_SIZE, page * WORKSPACE_OVERVIEW_PAGE_SIZE),
        state: value.state, stoppedCount: value.stoppedCount, totalCount: rows.length,
        transitioningCount: value.rows.filter((row) => ["starting", "stopping", "changing"].includes(row.state)).length,
        unknownCount: value.rows.filter((row) => row.state === "unknown").length,
        updatedAt: value.updatedAt
      };
    }
  };
}
