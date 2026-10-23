/**
 * Spike 3 of the native-agent queue: Workspace VM start latency and idle
 * memory on real KVM. Throwaway measurement code, never run in CI.
 *
 * It drives the runner HTTP API with the app's own client
 * (`RemoteWorkspaceRuntime`) in the order the app prepares a run
 * (`lib/server/workspace/coordinator.ts`): ensure (fence claim + VM create or
 * start), empty secrets sync, empty Skills preparation, tool catalog, then
 * `sandbox_shell` "echo ok". Operations follow the app's fence rules: a run
 * owns one operation generation, and run settlement retires it, which stops
 * the VM (`lib/server/workspace/operationFence.ts`).
 *
 * Scenarios per session (one VM runs at a time):
 *   cold      new chat: no sandbox yet, through the first command's result
 *   idle      session 0 only: memory every 30 s for --idle-seconds after the
 *             first command, with no further activity (the prewarmed state)
 *   warm      --warm more commands in the same run (same operation)
 *   takeover  next turn while the VM still runs: a new operation that names
 *             the previous one as predecessor, so the fence hands over without
 *             a VM stop. Today's app never does this between turns (it stops
 *             the VM at run end); it models a prewarmed or kept-warm VM.
 *   stop      --stop-resume: run settlement (claim + retire), which stops the VM
 *   resume    --stop-resume: next turn on the stopped VM (disk intact), which
 *             is what every follow-up turn costs today
 *   cleanup   claim + remove of the session; always runs, also on failure
 *
 * Output: content-free JSON lines on stdout, each with
 * `"spike":"workspace-vm-latency"` (the runtime's own structured logs share
 * stdout; filter on that key). Kinds:
 *   info     health, config and pre-existing session count
 *   phase    {scenario, phase, session, ms, ok}; phases are ensure, secrets,
 *            skills, catalog, first_exec, total (scenario sum), warm_exec,
 *            retire, remove, plus ensure_prepare / ensure_boot /
 *            ensure_guest_init when the SDK status poller saw the guest
 *            (see `splitEnsure`, 100 ms resolution)
 *   memory   {label, session, elapsedS?}: cgroupMB / cgroupAnonMB /
 *            cgroupFileMB of this container (it holds the runner, the VM
 *            processes and this script), vmProcessMB / vmAnonMB / vmShmemMB:
 *            resident memory of processes that did not exist when the script
 *            started (the VM, its helpers and the per-session MCP process),
 *            procs: that set grouped by executable name, and sdk*MB from
 *            Microsandbox's own metrics (host resident, guest used/available)
 *   error    {scenario, phase, session, code}: stable error codes only
 *   summary  per-phase statistics (n, min, p50, mean, max), idle memory
 *            trend, cleanup result and the prewarm decision of question (4)
 *
 * Guard: refuses unless AIQSA_WORKSPACE_SPIKE=DISPOSABLE, and refuses a runner
 * that already lists sessions unless --allow-existing-sessions.
 * Flags: --sessions N (3), --warm N (5), --idle-seconds S (180),
 * --stop-resume, --internet (Internet-On policy; default Off), --no-sdk (skip
 * the Microsandbox status poller and metrics), --runner-url URL (default
 * $AIQSA_WORKSPACE_RUNNER_URL or http://127.0.0.1:4310).
 *
 * Orchestrator steps on the KVM host (needs /dev/kvm, Docker, ~16 GiB RAM for
 * the image build, nothing else of an installation):
 *
 *   1. Export the inspected commit and build the runner target (it builds
 *      the release stage first, so it takes a while; the existing
 *      ghcr.io/insciqq/aiqsa:workspace-runner-0.3.7 image predates this script
 *      and its guest image, so it cannot run it as is):
 *        rm -rf /tmp/aiqsa-spike3 && mkdir /tmp/aiqsa-spike3
 *        git archive <commit> | tar -x -C /tmp/aiqsa-spike3
 *        docker build --target workspace-runner -t aiqsa-workspace-runner:spike3 /tmp/aiqsa-spike3
 *   2. Start one disposable runner the way compose.yaml does (synthetic
 *      token, no app origin so the agent gateway stays off, VM defaults
 *      2 CPU / 4096 MiB / 10240 MiB disk / idle stop 1800 s):
 *        docker volume create aiqsa-spike3-msb
 *        docker run -d --name aiqsa-spike3-runner --init --read-only \
 *          --cap-drop ALL --security-opt no-new-privileges:true \
 *          --device /dev/kvm:/dev/kvm --group-add "$(stat -c %g /dev/kvm)" \
 *          --memory 8g --cpus 4 --tmpfs /tmp:rw,nosuid,nodev,size=512m \
 *          -v aiqsa-spike3-msb:/var/lib/microsandbox \
 *          -e AIQSA_WORKSPACE_RUNNER_TOKEN="$(openssl rand -hex 32)" \
 *          -e AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME=0 \
 *          aiqsa-workspace-runner:spike3
 *      Wait until `docker logs aiqsa-spike3-runner` shows the startup
 *      "completed" lifecycle record (the first start loads the guest image).
 *   3. In a second terminal, start the host-side memory log and leave it
 *      running for the whole measurement (the VM processes are visible to the
 *      host through `docker top`):
 *        while true; do date -u +%FT%TZ; docker stats --no-stream --format '{{.MemUsage}}' aiqsa-spike3-runner; docker top aiqsa-spike3-runner -eo pid,rss,comm; sleep 30; done | tee spike3-host-memory.log
 *   4. Run the spike inside the runner container (it inherits the token,
 *      MSB_HOME and Workspace settings, and sees the VM processes):
 *        docker exec -e AIQSA_WORKSPACE_SPIKE=DISPOSABLE aiqsa-spike3-runner \
 *          node_modules/.bin/tsx scripts/spikes/workspace-vm-latency.ts --stop-resume \
 *          | grep '"spike":"workspace-vm-latency"' | tee spike3.jsonl
 *      Optionally repeat with --internet (Internet-On boot cost) and once
 *      right after a fresh `docker restart` (first boot after deploy).
 *   5. Remove everything: docker rm -f aiqsa-spike3-runner && docker volume rm aiqsa-spike3-msb
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Sandbox } from "microsandbox";
import { workspaceSandboxName } from "@/lib/domain/workspace";
import { hashCanonicalMcpValue } from "@/lib/server/mcp/definitions";
import { getWorkspaceConfig } from "@/lib/server/workspace/config";
import type { WorkspaceOperation } from "@/lib/server/workspace/operationFence";
import { RemoteWorkspaceRuntime } from "@/lib/server/workspace/remoteRuntime";
import { WorkspaceRuntimeError } from "@/lib/server/workspace/runtime";
import {
  OBSERVED_SANDBOX_STATUSES,
  SAMPLE_INTERVAL_SECONDS,
  SPIKE_NAME,
  cgroupMemory,
  groupProcesses,
  mb,
  parseCgroupStat,
  parseProcStatus,
  parseSpikeArgs,
  phaseStats,
  prewarmDecision,
  shellSucceeded,
  splitEnsure,
  summarizeIdle,
  type CgroupMemory,
  type IdleSample,
  type ObservedSandboxStatus,
  type ProcessMemory,
  type StatusFirstSeen
} from "./workspace-vm-latency-support";

if (process.env.AIQSA_WORKSPACE_SPIKE !== "DISPOSABLE") {
  throw new Error("workspace_spike_requires_disposable_confirmation");
}

const options = parseSpikeArgs(process.argv.slice(2), process.env);
const config = getWorkspaceConfig({
  ...process.env,
  AIQSA_TEST_MODE: "0",
  AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "0",
  AIQSA_WORKSPACE_RUNNER_URL: options.runnerUrl
});
const runtime = new RemoteWorkspaceRuntime(config);
/** The coordinator's manifest for a run without Skills. */
const EMPTY_SKILL_MANIFEST_HASH = hashCanonicalMcpValue({ version: 1, skills: [] });
const prefix = `spike3-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const interruption = new AbortController();

type Scenario = "cleanup" | "cold" | "resume" | "stop" | "takeover" | "warm";
type Tracked = {
  index: number;
  operation: WorkspaceOperation | null;
  removed: boolean;
  runtimeSandboxId: string | null;
  sandboxName: string;
  sessionId: string;
};

const tracked: Tracked[] = [];
const phases = new Map<string, number[]>();
const idleSamples: IdleSample[] = [];
let failures = 0;
let toolCallSequence = 0;

function emit(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ spike: SPIKE_NAME, ...record })}\n`);
}

function errorCode(error: unknown): string {
  if (error instanceof WorkspaceRuntimeError) return error.code;
  if (error instanceof Error && /^[a-z][a-z0-9_]{2,80}$/u.test(error.message)) return error.message;
  return error instanceof Error ? error.name : "unknown";
}

function recordPhase(scenario: Scenario, phase: string, session: number, ms: number): void {
  const rounded = Math.round(ms);
  emit({ kind: "phase", scenario, phase, session, ms: rounded, ok: true });
  const key = `${scenario}.${phase}`;
  phases.set(key, [...(phases.get(key) ?? []), rounded]);
}

async function timed<T>(scenario: Scenario, phase: string, session: number, action: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    const result = await action();
    recordPhase(scenario, phase, session, performance.now() - started);
    return result;
  } catch (error) {
    failures += 1;
    emit({ kind: "error", scenario, phase, session, ms: Math.round(performance.now() - started), code: errorCode(error) });
    throw error;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("spike_interrupted")); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(new Error("spike_interrupted")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

// The Microsandbox SDK serves only the status poller and metrics. The runner
// owns lifecycle; this process only reads persisted state (`Sandbox.get`).
function startStatusPoller(sandboxName: string, startedAt: number): () => Promise<StatusFirstSeen> {
  const seen: StatusFirstSeen = {};
  if (!options.sdk) return async () => seen;
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        const status = String((await Sandbox.get(sandboxName)).status);
        if ((OBSERVED_SANDBOX_STATUSES as readonly string[]).includes(status)) {
          seen[status as ObservedSandboxStatus] ??= Math.round(performance.now() - startedAt);
        }
      } catch {
        // Not created yet, or a transient read failure: keep polling.
      }
      await delay(100);
    }
  })();
  return async () => {
    stopped = true;
    await loop;
    return seen;
  };
}

async function sdkMetrics(sandboxName: string): Promise<Record<string, number | string | null>> {
  if (!options.sdk) return {};
  try {
    const metrics = await (await Sandbox.get(sandboxName)).metrics();
    return {
      sdkGuestAvailableMB: metrics.memoryAvailableBytes === null ? null : mb(metrics.memoryAvailableBytes),
      sdkGuestUsedMB: mb(metrics.memoryBytes),
      sdkHostResidentMB: metrics.memoryHostResidentBytes === null ? null : mb(metrics.memoryHostResidentBytes)
    };
  } catch (error) {
    // Class names only (for example MetricsDisabledError), never messages.
    return { sdkMetricsError: error instanceof Error ? error.name : "unknown" };
  }
}

async function readCgroup(): Promise<CgroupMemory | null> {
  try {
    const current = Number((await readFile("/sys/fs/cgroup/memory.current", "utf8")).trim());
    return cgroupMemory(2, current, parseCgroupStat(await readFile("/sys/fs/cgroup/memory.stat", "utf8")));
  } catch {
    try {
      const current = Number((await readFile("/sys/fs/cgroup/memory/memory.usage_in_bytes", "utf8")).trim());
      return cgroupMemory(1, current, parseCgroupStat(await readFile("/sys/fs/cgroup/memory/memory.stat", "utf8")));
    } catch {
      return null;
    }
  }
}

async function processIds(): Promise<number[]> {
  return (await readdir("/proc")).filter((entry) => /^\d+$/u.test(entry)).map(Number);
}

async function processesSince(baseline: ReadonlySet<number>): Promise<ProcessMemory[]> {
  const result: ProcessMemory[] = [];
  for (const pid of await processIds()) {
    if (baseline.has(pid)) continue;
    const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => null);
    const parsed = status === null ? null : parseProcStatus(status);
    if (parsed) result.push(parsed);
  }
  return result;
}

let baselinePids: ReadonlySet<number> = new Set();

async function sampleMemory(label: string, session: number, sandboxName: string | null, elapsedS?: number) {
  const [cgroup, processes, metrics] = await Promise.all([
    readCgroup(), processesSince(baselinePids), sandboxName ? sdkMetrics(sandboxName) : Promise.resolve<Record<string, number | string | null>>({})
  ]);
  const sum = (key: "anonKb" | "rssKb" | "shmemKb") => mb(processes.reduce((total, entry) => total + entry[key], 0) * 1_024);
  const sample = {
    cgroupAnonMB: cgroup?.anonMB ?? null,
    cgroupFileMB: cgroup?.fileMB ?? null,
    cgroupMB: cgroup?.currentMB ?? null,
    vmAnonMB: sum("anonKb"),
    vmProcessMB: sum("rssKb"),
    vmShmemMB: sum("shmemKb"),
    ...metrics
  };
  emit({ kind: "memory", label, session, ...(elapsedS === undefined ? {} : { elapsedS }), ...sample,
    procs: groupProcesses(processes) });
  return sample;
}

function nextOperation(session: Tracked, label: Scenario): WorkspaceOperation {
  return { generation: (session.operation?.generation ?? 0) + 1, owner: `spike3-${label}:${randomUUID()}` };
}

function fenceInput(session: Tracked) {
  return { operation: session.operation!, runtimeSandboxId: session.runtimeSandboxId, sessionId: session.sessionId };
}

async function shell(session: Tracked, runId: string): Promise<void> {
  toolCallSequence += 1;
  const result = await runtime.callBoundTool({
    arguments: { command: "echo ok", treatNonZeroAsError: true },
    modelRunId: runId,
    modelRunToolCallId: `${runId}-c${toolCallSequence}`,
    originalName: "sandbox_shell",
    operation: session.operation!,
    runtimeSandboxId: session.runtimeSandboxId!,
    sessionId: session.sessionId,
    signal: interruption.signal
  });
  if (!shellSucceeded(result)) throw new Error("spike_exec_failed");
}

/** One run's Workspace preparation and first command, in the coordinator's order. */
async function turn(session: Tracked, scenario: Scenario, predecessor?: WorkspaceOperation): Promise<string> {
  const index = session.index;
  const operation = nextOperation(session, scenario);
  // Record the generation before the claim, so cleanup always outranks it.
  session.operation = operation;
  const runId = `spike3-run-${randomUUID()}`;
  const signal = interruption.signal;
  const started = performance.now();
  const stopPoller = startStatusPoller(session.sandboxName, started);
  const ensure = () => runtime.ensureSession({
    cpus: config.cpus, diskMiB: config.diskMiB, imageRef: config.imageRef, internetEnabled: options.internet,
    memoryMiB: config.memoryMiB, operation, ...(predecessor ? { predecessor } : {}),
    runtimeSandboxId: session.runtimeSandboxId, sandboxName: session.sandboxName, sessionId: session.sessionId, signal
  });
  let ensured: Awaited<ReturnType<typeof ensure>>;
  try {
    ensured = await timed(scenario, "ensure", index, ensure);
  } finally {
    const ensureMs = performance.now() - started;
    const split = splitEnsure(await stopPoller(), ensureMs);
    if (split) {
      recordPhase(scenario, "ensure_prepare", index, split.prepareMs);
      recordPhase(scenario, "ensure_boot", index, split.bootMs);
      recordPhase(scenario, "ensure_guest_init", index, split.guestInitMs);
    }
  }
  if (session.runtimeSandboxId !== null && ensured.runtimeSandboxId !== session.runtimeSandboxId) {
    throw new Error("spike_sandbox_identity_changed");
  }
  session.runtimeSandboxId = ensured.runtimeSandboxId;
  const runtimeSandboxId = ensured.runtimeSandboxId;
  const sessionId = session.sessionId;
  await timed(scenario, "secrets", index, () => runtime.syncPersonalSecrets({
    secrets: [], modelRunId: runId, operation, runtimeSandboxId, sessionId, signal
  }));
  await timed(scenario, "skills", index, async () => {
    const identity = { manifestHash: EMPTY_SKILL_MANIFEST_HASH, modelRunId: runId, operation, runtimeSandboxId, sessionId, signal };
    const prepared = await runtime.prepareSkillRun({ ...identity, initial: [] });
    if (prepared.state !== "ready") await runtime.completeSkillRunPreparation(identity);
  });
  await timed(scenario, "catalog", index, async () => {
    const catalog = await runtime.loadBoundTools({ operation, runtimeSandboxId, sessionId, signal });
    if (!catalog.tools.some((tool) => tool.originalName === "sandbox_shell")) throw new Error("spike_catalog_incomplete");
  });
  await timed(scenario, "first_exec", index, () => shell(session, runId));
  recordPhase(scenario, "total", index, performance.now() - started);
  return runId;
}

/** Run settlement as the coordinator does it: claim (idempotent) and retire, which stops the VM. */
async function retire(session: Tracked, scenario: Scenario): Promise<void> {
  await timed(scenario, "retire", session.index, async () => {
    await runtime.claimSessionOperation(fenceInput(session)).catch(() => undefined);
    await runtime.retireSessionOperation(fenceInput(session));
  });
}

async function cleanup(session: Tracked): Promise<void> {
  if (session.removed) return;
  session.operation = nextOperation(session, "cleanup");
  for (let attempt = 1; attempt <= 3 && !session.removed; attempt += 1) {
    const started = performance.now();
    try {
      await runtime.claimSessionOperation(fenceInput(session));
      await runtime.removeSession(fenceInput(session));
      await runtime.retireSessionOperation(fenceInput(session)).catch(() => undefined);
      session.removed = true;
      recordPhase("cleanup", "remove", session.index, performance.now() - started);
    } catch (error) {
      emit({ kind: "error", scenario: "cleanup", phase: "remove", session: session.index, attempt, code: errorCode(error) });
    }
  }
  if (!session.removed) failures += 1;
}

async function measureSession(index: number): Promise<void> {
  const sessionId = `${prefix}-${index}`;
  const session: Tracked = {
    index, operation: null, removed: false, runtimeSandboxId: null,
    sandboxName: workspaceSandboxName(sessionId), sessionId
  };
  tracked.push(session);
  await sampleMemory("before", index, null);
  const runId = await turn(session, "cold", undefined);
  await sampleMemory("after_first_exec", index, session.sandboxName);

  if (index === 0 && options.idleSeconds > 0) {
    const started = performance.now();
    for (let elapsed = 0; elapsed <= options.idleSeconds; elapsed += SAMPLE_INTERVAL_SECONDS) {
      const wait = elapsed * 1_000 - (performance.now() - started);
      if (wait > 0) await delay(wait, interruption.signal);
      const sample = await sampleMemory("idle", index, session.sandboxName, elapsed);
      idleSamples.push({
        cgroupMB: sample.cgroupMB, elapsedS: elapsed, vmProcessMB: sample.vmProcessMB,
        sdkHostResidentMB: typeof (sample as Record<string, unknown>).sdkHostResidentMB === "number" ? (sample as Record<string, unknown>).sdkHostResidentMB as number : null
      });
    }
  }

  for (let command = 0; command < options.warm; command += 1) {
    await timed("warm", "warm_exec", index, () => shell(session, runId));
  }

  const previous = session.operation!;
  await turn(session, "takeover", previous);

  if (options.stopResume) {
    await retire(session, "stop");
    await sampleMemory("after_stop", index, session.sandboxName);
    await turn(session, "resume", undefined);
    await retire(session, "stop");
  }

  await cleanup(session);
  await sampleMemory("after_remove", index, null);
}

function summary(): Record<string, unknown> {
  const stats = Object.fromEntries([...phases.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => [key, phaseStats(values)]));
  const idle = summarizeIdle(idleSamples);
  const idleVmMB = idle ? idle.vmLastMB > 0 ? idle.vmLastMB : idle.sdkHostResidentLastMB : null;
  return {
    phases: stats,
    idle,
    cleanup: { sessions: tracked.length, removed: tracked.filter((entry) => entry.removed).length },
    decision: prewarmDecision({
      coldP50Ms: phaseStats(phases.get("cold.total") ?? [])?.p50 ?? null,
      idleVmMB,
      takeoverP50Ms: phaseStats(phases.get("takeover.total") ?? [])?.p50 ?? null
    })
  };
}

async function main(): Promise<void> {
  const stop = () => interruption.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  baselinePids = new Set(await processIds());
  const health = await runtime.health();
  emit({
    kind: "info", healthState: health.state, reasonCode: health.reasonCode ?? null, imageReady: health.imageReady ?? null,
    virtualizationReady: health.virtualizationReady ?? null, runtimeVersion: health.runtimeVersion ?? null,
    cpus: config.cpus, memoryMiB: config.memoryMiB, diskMiB: config.diskMiB, idleTtlSeconds: config.idleTtlSeconds,
    internetEnabled: options.internet, sessions: options.sessions, warm: options.warm, idleSeconds: options.idleSeconds,
    stopResume: options.stopResume, sdk: options.sdk, cgroupVersion: (await readCgroup())?.version ?? null
  });
  if (health.state !== "ready") throw new Error("spike_runner_not_ready");
  const inventory = await runtime.listSessions({});
  emit({ kind: "info", preexistingSessions: inventory.entries.length, morePages: inventory.nextCursor !== null });
  if ((inventory.entries.length > 0 || inventory.nextCursor !== null) && !options.allowExistingSessions) {
    throw new Error("spike_runner_not_empty");
  }
  await sampleMemory("baseline", -1, null);
  for (let index = 0; index < options.sessions; index += 1) {
    if (interruption.signal.aborted) throw new Error("spike_interrupted");
    await measureSession(index);
  }
}

async function run(): Promise<number> {
  let exitCode = 0;
  try {
    await main();
  } catch (error) {
    exitCode = 1;
    emit({ kind: "error", scenario: "run", phase: "main", session: null, code: errorCode(error) });
  } finally {
    // Every session this process created, also after a failure or Ctrl-C.
    for (const session of tracked) await cleanup(session);
  }
  const remaining = await runtime.listSessions({})
    .then((page) => page.entries.filter((entry) => tracked.some((session) => session.sandboxName === entry.sandboxName)).length)
    .catch(() => null);
  if (failures > 0 || remaining !== 0) exitCode = 1;
  emit({ kind: "summary", ok: exitCode === 0, failures, leftoverSessions: remaining, ...summary() });
  return exitCode;
}

// Native SDK handles may keep the loop alive; exit once stdout has flushed.
void run().then((code) => process.stdout.write("", () => process.exit(code)));
