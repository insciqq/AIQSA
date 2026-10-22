/**
 * Pure helpers of the Workspace VM latency spike (`workspace-vm-latency.ts`):
 * flag parsing, `/proc` and cgroup parsing, the ensure phase split, summary
 * statistics and the prewarm decision. No I/O here, so it is unit-tested.
 */

export const SPIKE_NAME = "workspace-vm-latency";
export const SAMPLE_INTERVAL_SECONDS = 30;
/** Prewarm pays off only when a cold start is slow and an idle VM is cheap. */
export const PREWARM_COLD_START_MS = 5_000;
export const PREWARM_IDLE_VM_MAX_MB = 500;

export type SpikeOptions = Readonly<{
  allowExistingSessions: boolean;
  idleSeconds: number;
  internet: boolean;
  runnerUrl: string;
  sdk: boolean;
  sessions: number;
  stopResume: boolean;
  warm: number;
}>;

export class SpikeUsageError extends Error {}

function integerFlag(name: string, raw: string | undefined, minimum: number, maximum: number): number {
  if (raw === undefined || !/^\d+$/u.test(raw)) throw new SpikeUsageError(`${name}_invalid`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new SpikeUsageError(`${name}_invalid`);
  return value;
}

export function parseSpikeArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): SpikeOptions {
  const options = {
    allowExistingSessions: false,
    idleSeconds: 180,
    internet: false,
    runnerUrl: env.AIQSA_WORKSPACE_RUNNER_URL?.trim() || "http://127.0.0.1:4310",
    sdk: true,
    sessions: 3,
    stopResume: false,
    warm: 5
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => argv[++index];
    switch (flag) {
      case "--sessions": options.sessions = integerFlag("sessions", value(), 1, 20); break;
      case "--warm": options.warm = integerFlag("warm", value(), 0, 100); break;
      case "--idle-seconds": options.idleSeconds = integerFlag("idle_seconds", value(), 0, 3_600); break;
      case "--stop-resume": options.stopResume = true; break;
      case "--internet": options.internet = true; break;
      case "--no-sdk": options.sdk = false; break;
      case "--allow-existing-sessions": options.allowExistingSessions = true; break;
      case "--runner-url": {
        const url = value();
        if (!url || !/^https?:\/\/[^\s]+$/u.test(url)) throw new SpikeUsageError("runner_url_invalid");
        options.runnerUrl = url;
        break;
      }
      default: throw new SpikeUsageError("flag_unknown");
    }
  }
  return options;
}

export type ProcessMemory = Readonly<{ anonKb: number; fileKb: number; name: string; rssKb: number; shmemKb: number }>;

/** Parses `/proc/<pid>/status`; null for a process without a resident set (exited or kernel). */
export function parseProcStatus(text: string): ProcessMemory | null {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  const kb = (key: string) => {
    const match = /^(\d+)\s*kB$/u.exec(fields.get(key) ?? "");
    return match ? Number(match[1]) : 0;
  };
  const name = fields.get("Name");
  if (!name || !fields.has("VmRSS")) return null;
  return { anonKb: kb("RssAnon"), fileKb: kb("RssFile"), name, rssKb: kb("VmRSS"), shmemKb: kb("RssShmem") };
}

export function mb(bytes: number): number {
  return Math.round((bytes / 1_048_576) * 10) / 10;
}

export type ProcessGroup = Readonly<{ anonMB: number; comm: string; count: number; rssMB: number; shmemMB: number }>;

/** Groups processes by executable name (`comm`), largest resident set first. */
export function groupProcesses(processes: readonly ProcessMemory[]): readonly ProcessGroup[] {
  const groups = new Map<string, { anonKb: number; count: number; rssKb: number; shmemKb: number }>();
  for (const entry of processes) {
    const group = groups.get(entry.name) ?? { anonKb: 0, count: 0, rssKb: 0, shmemKb: 0 };
    group.anonKb += entry.anonKb; group.count += 1; group.rssKb += entry.rssKb; group.shmemKb += entry.shmemKb;
    groups.set(entry.name, group);
  }
  return [...groups.entries()]
    .map(([comm, group]) => ({ anonMB: mb(group.anonKb * 1_024), comm, count: group.count,
      rssMB: mb(group.rssKb * 1_024), shmemMB: mb(group.shmemKb * 1_024) }))
    .sort((left, right) => right.rssMB - left.rssMB || left.comm.localeCompare(right.comm));
}

/** Parses a cgroup `memory.stat` (v1 or v2) into byte counters. */
export function parseCgroupStat(text: string): ReadonlyMap<string, number> {
  const values = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^([a-z_]+)\s+(\d+)$/u.exec(line.trim());
    if (match) values.set(match[1]!, Number(match[2]));
  }
  return values;
}

export type CgroupMemory = Readonly<{ anonMB: number | null; currentMB: number; fileMB: number | null; version: 1 | 2 }>;

export function cgroupMemory(version: 1 | 2, currentBytes: number, stat: ReadonlyMap<string, number>): CgroupMemory {
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = stat.get(key);
      if (value !== undefined) return mb(value);
    }
    return null;
  };
  return version === 2
    ? { anonMB: pick("anon"), currentMB: mb(currentBytes), fileMB: pick("file"), version }
    : { anonMB: pick("total_rss", "rss"), currentMB: mb(currentBytes), fileMB: pick("total_cache", "cache"), version };
}

export const OBSERVED_SANDBOX_STATUSES = ["created", "starting", "running", "draining", "paused", "stopped", "crashed"] as const;
export type ObservedSandboxStatus = (typeof OBSERVED_SANDBOX_STATUSES)[number];
export type StatusFirstSeen = Partial<Record<ObservedSandboxStatus, number>>;

export type EnsureSplit = Readonly<{ bootMs: number; guestInitMs: number; prepareMs: number }>;

/**
 * Splits one ensure call by the first time the SDK reported each status
 * (milliseconds since the ensure request). `prepare` runs until the guest is
 * created or starting (fence claim, image and disk preparation), `boot` until
 * it reports running, and `guestInit` until ensure returns (workspace
 * directories, release guides, response). A pre-existing `stopped` state is
 * ignored, so a resume splits the same way. Null without a running status.
 */
export function splitEnsure(seen: StatusFirstSeen, ensureMs: number): EnsureSplit | null {
  const running = seen.running;
  if (running === undefined) return null;
  const beginnings = [seen.created, seen.starting].filter((value): value is number => value !== undefined && value <= running);
  const started = beginnings.length > 0 ? Math.min(...beginnings) : running;
  return {
    bootMs: running - started,
    guestInitMs: Math.max(0, ensureMs - running),
    prepareMs: started
  };
}

export type PhaseStats = Readonly<{ max: number; mean: number; min: number; n: number; p50: number }>;

export function phaseStats(values: readonly number[]): PhaseStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const p50 = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    max: round(sorted[sorted.length - 1]!),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    min: round(sorted[0]!),
    n: sorted.length,
    p50: round(p50)
  };
}

export type IdleSample = Readonly<{ cgroupMB: number | null; elapsedS: number; sdkHostResidentMB: number | null; vmProcessMB: number }>;

export type IdleSummary = Readonly<{
  cgroupFirstMB: number | null;
  cgroupLastMB: number | null;
  samples: number;
  sdkHostResidentLastMB: number | null;
  /** First minus last idle sample of the session's own processes; positive means it shrank. */
  shrankMB: number;
  vmFirstMB: number;
  vmLastMB: number;
  vmMaxMB: number;
}>;

export function summarizeIdle(samples: readonly IdleSample[]): IdleSummary | null {
  if (samples.length === 0) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  return {
    cgroupFirstMB: first.cgroupMB,
    cgroupLastMB: last.cgroupMB,
    samples: samples.length,
    sdkHostResidentLastMB: last.sdkHostResidentMB,
    shrankMB: Math.round((first.vmProcessMB - last.vmProcessMB) * 10) / 10,
    vmFirstMB: first.vmProcessMB,
    vmLastMB: last.vmProcessMB,
    vmMaxMB: Math.max(...samples.map((sample) => sample.vmProcessMB))
  };
}

export type PrewarmDecision = Readonly<{
  coldP50Ms: number | null;
  idleVmMB: number | null;
  prewarm: "no" | "undecided" | "yes";
  reason: "cold_start_fast" | "idle_vm_expensive" | "measurement_missing" | "slow_cold_start_cheap_idle_vm";
  /** What a prewarmed (taken-over) VM saves on the first command, by p50. */
  savedP50Ms: number | null;
}>;

/**
 * Question (4) of the spike: prewarm on file attach only when a cold start is
 * slower than the threshold and one idle VM costs less than the ceiling.
 */
export function prewarmDecision(input: Readonly<{
  coldP50Ms: number | null;
  idleVmMB: number | null;
  takeoverP50Ms: number | null;
}>): PrewarmDecision {
  const savedP50Ms = input.coldP50Ms !== null && input.takeoverP50Ms !== null
    ? Math.round(input.coldP50Ms - input.takeoverP50Ms) : null;
  const base = { coldP50Ms: input.coldP50Ms, idleVmMB: input.idleVmMB, savedP50Ms };
  if (input.coldP50Ms === null || input.idleVmMB === null) return { ...base, prewarm: "undecided", reason: "measurement_missing" };
  if (input.coldP50Ms <= PREWARM_COLD_START_MS) return { ...base, prewarm: "no", reason: "cold_start_fast" };
  if (input.idleVmMB >= PREWARM_IDLE_VM_MAX_MB) return { ...base, prewarm: "no", reason: "idle_vm_expensive" };
  return { ...base, prewarm: "yes", reason: "slow_cold_start_cheap_idle_vm" };
}

/** True when a `sandbox_shell` result proves the command ran and exited 0. */
export function shellSucceeded(result: Readonly<{ content: readonly Readonly<{ text?: string }>[]; status: string }>): boolean {
  if (result.status !== "complete") return false;
  try {
    const parsed = JSON.parse(result.content[0]?.text ?? "null") as { data?: { success?: unknown }; ok?: unknown } | null;
    return parsed?.ok === true && parsed.data?.success === true;
  } catch {
    return false;
  }
}
