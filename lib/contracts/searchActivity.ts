/** Counts accepted AIQSA search-engine work, not hosted web operations or HTTP attempts. */
export type ThreadSearchEngineActivity = Readonly<{
  engine: number;
  name: string;
  requested: number;
  settled: number;
  complete: number;
  error: number;
  skipped: number;
}>;
export type ThreadSearchActivitySnapshot = Readonly<{ engines: ThreadSearchEngineActivity[] }>;

const validCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10_000;

export function decodeThreadSearchEngineActivity(value: unknown): ThreadSearchEngineActivity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["engine", "name", "requested", "settled", "complete", "error", "skipped"].includes(key)) ||
    !Number.isSafeInteger(row.engine) || Number(row.engine) < 1 || Number(row.engine) > 3 ||
    typeof row.name !== "string" || !row.name.trim() || row.name.length > 160 ||
    /[\u0000-\u001f\u007f]/u.test(row.name) ||
    !validCount(row.requested) || !validCount(row.settled) || !validCount(row.complete) ||
    !validCount(row.error) || !validCount(row.skipped) ||
    row.settled > row.requested || row.complete + row.error + row.skipped > row.settled) return null;
  return { engine: row.engine as number, name: row.name.trim(), requested: row.requested, settled: row.settled,
    complete: row.complete, error: row.error, skipped: row.skipped };
}

export function decodeThreadSearchActivitySnapshot(value: unknown): ThreadSearchActivitySnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== 1 || !Array.isArray(data.engines) ||
    data.engines.length < 1 || data.engines.length > 3) return null;
  const engines = data.engines.map(decodeThreadSearchEngineActivity);
  if (engines.some(engine => engine === null) ||
    new Set(engines.map(engine => engine?.engine)).size !== engines.length) return null;
  return { engines: engines as ThreadSearchEngineActivity[] };
}

/** Absolute counters merge monotonically across duplicate or out-of-order SSE snapshots. */
export function mergeThreadSearchEngineActivity(
  previous: readonly ThreadSearchEngineActivity[],
  next: readonly ThreadSearchEngineActivity[]
): ThreadSearchEngineActivity[] {
  const merged = new Map(previous.map(row => [row.engine, row]));
  for (const row of next) {
    const old = merged.get(row.engine);
    if (!old) { merged.set(row.engine, row); continue; }
    const complete = Math.max(old.complete, row.complete);
    const error = Math.max(old.error, row.error);
    const skipped = Math.max(old.skipped, row.skipped);
    const settled = Math.max(old.settled, row.settled, complete + error + skipped);
    merged.set(row.engine, { ...row, requested: Math.max(old.requested, row.requested, settled),
      settled, complete, error, skipped });
  }
  return [...merged.values()].sort((a, b) => a.engine - b.engine);
}

export function runningSearchEngineCalls(row: ThreadSearchEngineActivity): number {
  return Math.max(0, row.requested - row.settled);
}

export function unknownSearchEngineCalls(row: ThreadSearchEngineActivity): number {
  return Math.max(0, row.settled - row.complete - row.error - row.skipped);
}
