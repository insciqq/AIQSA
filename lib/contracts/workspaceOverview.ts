export const WORKSPACE_OVERVIEW_PAGE_SIZE = 20;
export const WORKSPACE_OVERVIEW_STATES = [
  "ready", "running", "starting", "stopping", "changing", "paused", "stopped", "not_started", "unknown"
] as const;

export type WorkspaceOverviewState = (typeof WORKSPACE_OVERVIEW_STATES)[number];
export type WorkspaceOverviewFilter = "active" | "all";
export type WorkspaceOverviewRow = Readonly<{
  context: "personal" | "project" | null;
  id: string;
  lastActiveAt: string | null;
  state: WorkspaceOverviewState;
  user: string | null;
}>;

export type WorkspaceOverviewWire = Readonly<{
  activeCount: number | null;
  filter: WorkspaceOverviewFilter;
  observedAt: string | null;
  page: number;
  pageSize: number;
  rows: readonly WorkspaceOverviewRow[];
  state: "fresh" | "stale" | "unavailable";
  stoppedCount: number | null;
  totalCount: number;
  transitioningCount: number;
  unknownCount: number;
  updatedAt: string;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

export function decodeWorkspaceOverviewResponse(value: unknown): WorkspaceOverviewWire | null {
  if (!record(value) || !record(value.overview)) return null;
  const overview = value.overview;
  if (!(overview.filter === "active" || overview.filter === "all") ||
    !(overview.state === "fresh" || overview.state === "stale" || overview.state === "unavailable") ||
    !count(overview.page) || overview.page < 1 || overview.pageSize !== WORKSPACE_OVERVIEW_PAGE_SIZE ||
    !count(overview.totalCount) || !count(overview.transitioningCount) || !count(overview.unknownCount) ||
    !(overview.activeCount === null || count(overview.activeCount)) ||
    !(overview.stoppedCount === null || count(overview.stoppedCount)) ||
    !timestamp(overview.updatedAt) || !(overview.observedAt === null || timestamp(overview.observedAt)) ||
    !Array.isArray(overview.rows) || overview.rows.length > WORKSPACE_OVERVIEW_PAGE_SIZE ||
    overview.rows.length > overview.totalCount) return null;
  if (overview.state === "unavailable" ? overview.activeCount !== null || overview.observedAt !== null
    : overview.activeCount === null || overview.stoppedCount === null || overview.observedAt === null) return null;
  const rows: WorkspaceOverviewRow[] = [];
  for (const row of overview.rows) {
    if (!record(row) || typeof row.id !== "string" || !/^ws-[a-f0-9]{16}$/u.test(row.id) ||
      !(row.context === null || row.context === "personal" || row.context === "project") ||
      !(row.user === null || typeof row.user === "string" && row.user.length > 0 && row.user.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(row.user)) ||
      !(row.lastActiveAt === null || timestamp(row.lastActiveAt)) ||
      !(WORKSPACE_OVERVIEW_STATES as readonly unknown[]).includes(row.state)) return null;
    rows.push({ context: row.context, id: row.id, lastActiveAt: row.lastActiveAt,
      state: row.state as WorkspaceOverviewState, user: row.user });
  }
  if (new Set(rows.map((row) => row.id)).size !== rows.length) return null;
  return {
    activeCount: overview.activeCount, filter: overview.filter, observedAt: overview.observedAt,
    page: overview.page, pageSize: overview.pageSize, rows, state: overview.state,
    stoppedCount: overview.stoppedCount, totalCount: overview.totalCount,
    transitioningCount: overview.transitioningCount, unknownCount: overview.unknownCount,
    updatedAt: overview.updatedAt
  };
}
