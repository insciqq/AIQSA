import {
  ToolHiveClient,
  ToolHiveClientError,
  type ToolHiveLocalWorkloadRequest,
  type ToolHiveWorkloadDetail,
  type ToolHiveWorkloadStatus,
  type ToolHiveWorkloadSummary
} from "./toolhiveClient";
import {
  McpClientSessionError,
  type McpFatalResponseErrorCode
} from "./clientSession";
import { isToolHiveGeneratedImage } from "./localArtifact";

const DEFAULT_LIFECYCLE_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const RESTART_TRANSITION_POLL_LIMIT = 4;
const OWNER_TOKEN_PATTERN = /^[a-z0-9]{16,24}$/u;
const GENERATION_TOKEN_PATTERN = /^[a-z0-9]{24,64}$/u;
const RESTARTABLE_WORKLOAD_STATUSES: ReadonlySet<ToolHiveWorkloadStatus> = new Set([
  "error",
  "stopped",
  "unhealthy",
  "unknown"
]);
const WAITING_WORKLOAD_STATUSES: ReadonlySet<ToolHiveWorkloadStatus> = new Set([
  "auth_retrying",
  "starting"
]);
const TERMINAL_MCP_RESPONSE_ERROR_CODES: ReadonlySet<string> = new Set<McpFatalResponseErrorCode>([
  "mcp_call_result_too_large",
  "mcp_initialize_response_too_large",
  "mcp_inventory_response_too_large",
  "mcp_response_too_large"
]);

export type ToolHiveRuntimeErrorCode =
  | "toolhive_lifecycle_aborted"
  | "toolhive_lifecycle_timed_out"
  | "toolhive_ownership_invalid"
  | "toolhive_proxy_unavailable"
  | "toolhive_workload_conflict"
  | "toolhive_workload_failed";

export class ToolHiveRuntimeError extends Error {
  readonly code: ToolHiveRuntimeErrorCode;

  constructor(code: ToolHiveRuntimeErrorCode) {
    super(code);
    this.name = "ToolHiveRuntimeError";
    this.code = code;
  }
}

export type ToolHiveOwnedWorkloadSpec = Readonly<{
  cmdArguments: readonly string[];
  envVars: Readonly<Record<string, string>>;
  generationToken: string;
  image: string;
}>;

export type ToolHiveReadyWorkload = Readonly<{
  name: string;
  port: number;
  status: "running";
  url: string;
}>;

export type ToolHiveProxyProbe = (
  url: string,
  signal?: AbortSignal
) => Promise<void>;

type PollOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

function runtimeError(code: ToolHiveRuntimeErrorCode): ToolHiveRuntimeError {
  return new ToolHiveRuntimeError(code);
}

function isTerminalMcpResponseError(error: unknown): boolean {
  return error instanceof McpClientSessionError &&
    TERMINAL_MCP_RESPONSE_ERROR_CODES.has(error.code);
}

function validateOwnerToken(token: string): void {
  if (!OWNER_TOKEN_PATTERN.test(token)) throw runtimeError("toolhive_ownership_invalid");
}

function validateGenerationToken(token: string): void {
  if (!GENERATION_TOKEN_PATTERN.test(token)) throw runtimeError("toolhive_ownership_invalid");
}

export function toolHiveOwnerGroupName(ownerToken: string): string {
  validateOwnerToken(ownerToken);
  return `aiqsa-${ownerToken}`;
}

export function toolHiveOwnedWorkloadName(
  ownerToken: string,
  generationToken: string
): string {
  const group = toolHiveOwnerGroupName(ownerToken);
  validateGenerationToken(generationToken);
  const name = `${group}-${generationToken}`;
  if (name.length > 100) throw runtimeError("toolhive_ownership_invalid");
  return name;
}

function recordsEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return leftEntries.length === rightEntries.length && leftEntries.every(([key, value], index) => {
    const candidate = rightEntries[index];
    return candidate?.[0] === key && candidate[1] === value;
  });
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => right[index] === value);
}

function environmentMatches(
  observed: Readonly<Record<string, string>>,
  requested: Readonly<Record<string, string>>
): boolean {
  if (recordsEqual(observed, requested)) return true;
  if (Object.hasOwn(requested, "MCP_TRANSPORT")) return false;
  return recordsEqual(observed, { ...requested, MCP_TRANSPORT: "stdio" });
}

function exactLocalConfiguration(
  detail: ToolHiveWorkloadDetail,
  request: ToolHiveLocalWorkloadRequest
): boolean {
  const materializedPackage = /^(?:npx|uvx):\/\//u.test(request.image);
  return detail.name === request.name &&
    detail.group === request.group &&
    (detail.image === request.image ||
      (materializedPackage && isToolHiveGeneratedImage(detail.image))) &&
    detail.host === "0.0.0.0" &&
    detail.transport === "stdio" &&
    detail.proxyMode === "streamable-http" &&
    detail.networkIsolation === false &&
    arraysEqual(detail.cmdArguments, request.cmdArguments) &&
    environmentMatches(detail.envVars, request.envVars);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(runtimeError("toolhive_lifecycle_aborted"));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, ms);
    timeout.unref?.();
    const handleAbort = () => {
      clearTimeout(timeout);
      reject(runtimeError("toolhive_lifecycle_aborted"));
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

type LifecycleGateWaiter = {
  resolve: (release: () => void) => void;
};

class ToolHiveLifecycleGate {
  #active = false;
  readonly #waiters: LifecycleGateWaiter[] = [];

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(runtimeError("toolhive_lifecycle_aborted"));
    }
    if (!this.#active) {
      this.#active = true;
      return Promise.resolve(this.#release());
    }
    return new Promise<() => void>((resolve, reject) => {
      let waiter: LifecycleGateWaiter;
      const abort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(runtimeError("toolhive_lifecycle_aborted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      waiter = {
        resolve: (release) => {
          signal?.removeEventListener("abort", abort);
          resolve(release);
        }
      };
      this.#waiters.push(waiter);
    });
  }

  #release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next) {
        next.resolve(this.#release());
        return;
      }
      this.#active = false;
    };
  }
}

export class ToolHiveMcpRuntimeDriver {
  readonly #client: ToolHiveClient;
  readonly #groupName: string;
  readonly #lifecycleGate = new ToolHiveLifecycleGate();
  readonly #lifecycleTimeoutMs: number;
  readonly #now: () => number;
  readonly #ownerToken: string;
  readonly #pollIntervalMs: number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(input: Readonly<{
    client: ToolHiveClient;
    lifecycleTimeoutMs?: number;
    now?: () => number;
    ownerToken: string;
    pollIntervalMs?: number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  }>) {
    this.#groupName = toolHiveOwnerGroupName(input.ownerToken);
    this.#client = input.client;
    this.#ownerToken = input.ownerToken;
    this.#lifecycleTimeoutMs = input.lifecycleTimeoutMs ?? DEFAULT_LIFECYCLE_TIMEOUT_MS;
    this.#pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#now = input.now ?? Date.now;
    this.#sleep = input.sleep ?? abortableDelay;
    if (
      !Number.isInteger(this.#lifecycleTimeoutMs) ||
      this.#lifecycleTimeoutMs <= 0 ||
      !Number.isInteger(this.#pollIntervalMs) ||
      this.#pollIntervalMs <= 0
    ) {
      throw runtimeError("toolhive_ownership_invalid");
    }
  }

  get groupName(): string {
    return this.#groupName;
  }

  workloadName(generationToken: string): string {
    return toolHiveOwnedWorkloadName(this.#ownerToken, generationToken);
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    await this.#withLifecycle(signal, () => this.#initialize(signal));
  }

  async #initialize(signal?: AbortSignal): Promise<void> {
    await this.#client.checkHealth(signal);
    await this.#client.assertCompatibleVersion(signal);
    await this.#client.ensureGroup(this.#groupName, signal);
  }

  async listOwnedWorkloads(signal?: AbortSignal): Promise<readonly ToolHiveWorkloadSummary[]> {
    const workloads = await this.#client.listWorkloads({
      group: this.#groupName,
      ...(signal ? { signal } : {})
    });
    return workloads
      .filter((workload) => this.#isOwned(workload))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async ensureReadyWorkload(
    spec: ToolHiveOwnedWorkloadSpec,
    input: PollOptions & { probe: ToolHiveProxyProbe }
  ): Promise<ToolHiveReadyWorkload> {
    return this.#withLifecycle(input.signal, async () => {
      const request = this.#requestFor(spec);
      await this.#initialize(input.signal);
      let workload = await this.#findExact(request.name, input.signal);
      let restartAttempted = false;

      if (!workload) {
        try {
          await this.#client.createLocalWorkload(request, input.signal);
        } catch (error) {
          if (!(error instanceof ToolHiveClientError) || error.status !== 409) throw error;
        }
        workload = await this.#findExact(request.name, input.signal);
      }

      if (workload) {
        const detail = await this.#getExactDetail(workload, request, input.signal);
        if (workload.status === "running") {
          const ready = await this.#probeOnce(workload, input.probe, input.signal);
          if (ready) return ready;
          await this.#restartExact(request.name, detail.image, input.signal);
          restartAttempted = true;
        } else if (RESTARTABLE_WORKLOAD_STATUSES.has(workload.status)) {
          await this.#restartExact(request.name, detail.image, input.signal);
          restartAttempted = true;
        } else if (!WAITING_WORKLOAD_STATUSES.has(workload.status)) {
          throw runtimeError("toolhive_workload_failed");
        }
      }

      return this.#waitUntilReady(request, input.probe, input, restartAttempted);
    });
  }

  async restartOwnedWorkload(
    generationToken: string,
    probe: ToolHiveProxyProbe,
    input: PollOptions = {}
  ): Promise<ToolHiveReadyWorkload | null> {
    return this.#withLifecycle(input.signal, async () => {
      const name = this.workloadName(generationToken);
      const workload = await this.#findExact(name, input.signal);
      if (!workload) return null;
      this.#assertLocalWorkload(workload);
      const detail = await this.#client.getWorkload(name, input.signal);
      await this.#restartExact(name, detail.image, input.signal);
      const request: ToolHiveLocalWorkloadRequest = {
        cmdArguments: detail.cmdArguments,
        envVars: detail.envVars,
        group: this.#groupName,
        image: detail.image,
        name
      };
      return this.#waitUntilReady(request, probe, input, true);
    });
  }

  async stopOwnedWorkload(
    generationToken: string,
    input: PollOptions = {}
  ): Promise<boolean> {
    return this.#withLifecycle(input.signal, async () => {
      const name = this.workloadName(generationToken);
      const workload = await this.#findExact(name, input.signal);
      if (!workload) return false;
      this.#assertOwnership(workload);
      if (workload.status !== "stopped") {
        await this.#client.stopWorkload(name, input.signal);
        await this.#waitForStatus(name, ["stopped"], input, true);
      }
      return true;
    });
  }

  async deleteOwnedWorkload(
    generationToken: string,
    input: PollOptions = {}
  ): Promise<boolean> {
    return this.#withLifecycle(input.signal, async () => {
      const name = this.workloadName(generationToken);
      const workload = await this.#findExact(name, input.signal);
      if (!workload) return false;
      this.#assertOwnership(workload);
      await this.#client.deleteWorkload(name, input.signal);
      await this.#waitUntilMissing(name, input);
      return true;
    });
  }

  async cleanupOwnedWorkloads(input: Readonly<{
    keepGenerationTokens?: readonly string[];
    signal?: AbortSignal;
    timeoutMs?: number;
  }> = {}): Promise<readonly string[]> {
    return this.#withLifecycle(input.signal, () => this.#cleanupOwnedWorkloads(input));
  }

  async #cleanupOwnedWorkloads(input: Readonly<{
    keepGenerationTokens?: readonly string[];
    signal?: AbortSignal;
    timeoutMs?: number;
  }>): Promise<readonly string[]> {
    const keep = new Set((input.keepGenerationTokens ?? []).map((token) => this.workloadName(token)));
    const deleted: string[] = [];
    for (const workload of await this.listOwnedWorkloads(input.signal)) {
      if (keep.has(workload.name)) continue;
      this.#assertOwnership(workload);
      await this.#client.deleteWorkload(workload.name, input.signal);
      await this.#waitUntilMissing(workload.name, input);
      deleted.push(workload.name);
    }
    return deleted;
  }

  async cleanupOwnedInstallation(input: PollOptions = {}): Promise<Readonly<{
    deletedWorkloads: readonly string[];
    groupDeleted: boolean;
  }>> {
    return this.#withLifecycle(input.signal, async () => {
      const deletedWorkloads = await this.#cleanupOwnedWorkloads(input);
      const remaining = await this.#client.listWorkloads({
        group: this.#groupName,
        ...(input.signal ? { signal: input.signal } : {})
      });
      if (remaining.length > 0) return { deletedWorkloads, groupDeleted: false };
      await this.#client.deleteGroup(this.#groupName, {
        ...(input.signal ? { signal: input.signal } : {})
      });
      return { deletedWorkloads, groupDeleted: true };
    });
  }

  async #withLifecycle<Result>(
    signal: AbortSignal | undefined,
    operation: () => Promise<Result>
  ): Promise<Result> {
    const release = await this.#lifecycleGate.acquire(signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #getExactDetail(
    workload: ToolHiveWorkloadSummary,
    request: ToolHiveLocalWorkloadRequest,
    signal?: AbortSignal
  ): Promise<ToolHiveWorkloadDetail> {
    this.#assertLocalWorkload(workload);
    const detail = await this.#client.getWorkload(request.name, signal);
    if (!exactLocalConfiguration(detail, request) || detail.proxyPort !== workload.port) {
      throw runtimeError("toolhive_workload_conflict");
    }
    return detail;
  }

  async #restartExact(
    name: string,
    expectedImage: string,
    signal?: AbortSignal
  ): Promise<void> {
    await this.#client.restartWorkload(name, {
      expectedImage,
      ...(signal ? { signal } : {})
    });
  }

  #requestFor(spec: ToolHiveOwnedWorkloadSpec): ToolHiveLocalWorkloadRequest {
    return {
      cmdArguments: spec.cmdArguments,
      envVars: spec.envVars,
      group: this.#groupName,
      image: spec.image,
      name: this.workloadName(spec.generationToken)
    };
  }

  #isOwned(workload: ToolHiveWorkloadSummary): boolean {
    if (workload.group !== this.#groupName || !workload.name.startsWith(`${this.#groupName}-`)) {
      return false;
    }
    return GENERATION_TOKEN_PATTERN.test(workload.name.slice(this.#groupName.length + 1));
  }

  #assertOwnership(workload: ToolHiveWorkloadSummary): void {
    if (!this.#isOwned(workload)) throw runtimeError("toolhive_ownership_invalid");
  }

  #assertLocalWorkload(workload: ToolHiveWorkloadSummary): void {
    this.#assertOwnership(workload);
    if (
      workload.remote ||
      workload.transportType !== "stdio" ||
      workload.proxyMode !== "streamable-http"
    ) {
      throw runtimeError("toolhive_workload_conflict");
    }
  }

  async #findExact(
    name: string,
    signal?: AbortSignal
  ): Promise<ToolHiveWorkloadSummary | null> {
    const workloads = await this.#client.listWorkloads({
      group: this.#groupName,
      ...(signal ? { signal } : {})
    });
    const workload = workloads.find((candidate) => candidate.name === name) ?? null;
    if (workload) this.#assertOwnership(workload);
    return workload;
  }

  async #probeOnce(
    workload: ToolHiveWorkloadSummary,
    probe: ToolHiveProxyProbe,
    signal?: AbortSignal
  ): Promise<ToolHiveReadyWorkload | null> {
    this.#assertLocalWorkload(workload);
    if (workload.status !== "running") return null;
    const url = this.#client.normalizeStdioProxyUrl(workload);
    try {
      await probe(url, signal);
    } catch (error) {
      if (signal?.aborted) throw runtimeError("toolhive_lifecycle_aborted");
      if (isTerminalMcpResponseError(error)) throw error;
      return null;
    }
    return { name: workload.name, port: workload.port, status: "running", url };
  }

  async #waitUntilReady(
    request: ToolHiveLocalWorkloadRequest,
    probe: ToolHiveProxyProbe,
    input: PollOptions,
    restartAttempted: boolean
  ): Promise<ToolHiveReadyWorkload> {
    const deadline = this.#deadline(input.timeoutMs);
    let observedRunning = false;
    let restartTransitionPolls = restartAttempted ? RESTART_TRANSITION_POLL_LIMIT : 0;
    while (this.#now() <= deadline) {
      if (input.signal?.aborted) throw runtimeError("toolhive_lifecycle_aborted");
      const workload = await this.#findExact(request.name, input.signal);
      if (workload) {
        const detail = await this.#getExactDetail(workload, request, input.signal);
        if (workload.status === "running") {
          observedRunning = true;
          const ready = await this.#probeOnce(workload, probe, input.signal);
          if (ready) return ready;
        } else if (RESTARTABLE_WORKLOAD_STATUSES.has(workload.status)) {
          if (restartAttempted) {
            if (restartTransitionPolls <= 0) {
              throw runtimeError("toolhive_workload_failed");
            }
            restartTransitionPolls -= 1;
          } else {
            await this.#restartExact(request.name, detail.image, input.signal);
            restartAttempted = true;
            restartTransitionPolls = RESTART_TRANSITION_POLL_LIMIT;
          }
        } else if (
          workload.status === "stopping" &&
          restartAttempted &&
          restartTransitionPolls > 0
        ) {
          restartTransitionPolls -= 1;
        } else if (!WAITING_WORKLOAD_STATUSES.has(workload.status)) {
          throw runtimeError("toolhive_workload_failed");
        }
      }
      await this.#sleep(this.#pollIntervalMs, input.signal);
    }
    throw runtimeError(observedRunning ? "toolhive_proxy_unavailable" : "toolhive_lifecycle_timed_out");
  }

  async #waitForStatus(
    name: string,
    statuses: readonly ToolHiveWorkloadStatus[],
    input: PollOptions,
    missingIsSuccess: boolean
  ): Promise<void> {
    const deadline = this.#deadline(input.timeoutMs);
    while (this.#now() <= deadline) {
      if (input.signal?.aborted) throw runtimeError("toolhive_lifecycle_aborted");
      const status = await this.#client.findWorkloadStatus(name, input.signal);
      if (status === null && missingIsSuccess) return;
      if (status !== null && statuses.includes(status)) return;
      await this.#sleep(this.#pollIntervalMs, input.signal);
    }
    throw runtimeError("toolhive_lifecycle_timed_out");
  }

  async #waitUntilMissing(name: string, input: PollOptions): Promise<void> {
    const deadline = this.#deadline(input.timeoutMs);
    while (this.#now() <= deadline) {
      if (input.signal?.aborted) throw runtimeError("toolhive_lifecycle_aborted");
      if (!(await this.#findExact(name, input.signal))) return;
      await this.#sleep(this.#pollIntervalMs, input.signal);
    }
    throw runtimeError("toolhive_lifecycle_timed_out");
  }

  #deadline(timeoutMs?: number): number {
    const timeout = timeoutMs ?? this.#lifecycleTimeoutMs;
    if (!Number.isInteger(timeout) || timeout <= 0) {
      throw runtimeError("toolhive_lifecycle_timed_out");
    }
    return this.#now() + timeout;
  }
}
