import {
  McpClientSessionError,
  validateMcpToolArguments,
  type AiqsaMcpServerEvidence,
  type AiqsaMcpToolCallResult,
  type McpFatalResponseErrorCode
} from "./clientSession";
import type { McpOperationalStatus } from "@/lib/contracts/mcp";
import { redactMcpToolCallResult } from "./resultRedaction";
import { ToolHiveClientError } from "./toolhiveClient";

export type McpRuntimeInventoryTool = {
  annotations?: Record<string, boolean | string>;
  definitionHash: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  name: string;
  outputSchema?: Record<string, unknown>;
  title?: string;
};

export type McpRuntimeLaunch = {
  allowPrivateNetwork?: boolean;
  callTimeoutMs: number;
  disabledToolNames?: readonly string[];
  fingerprint: string;
  generationId: string;
  headers: Record<string, string>;
  inventoryRefreshRequired?: boolean;
  onConnecting?(): Promise<void>;
  redactionValues: readonly string[];
  oauthConnectionId?: string;
  retryAt: Date | null;
  startupTimeoutMs: number;
  trustedInternalHttp?: boolean;
  toolHive?: {
    cmdArguments: readonly string[];
    envVars: Readonly<Record<string, string>>;
    generationToken: string;
    image: string;
  };
  url?: string;
};

export type McpRuntimeSession = {
  callTool(input: {
    arguments: Record<string, unknown>;
    name: string;
    signal?: AbortSignal;
  }): Promise<AiqsaMcpToolCallResult>;
  close(): Promise<void>;
  dispose?(): Promise<void>;
  exactKnownSecrets?(): readonly string[];
  fatalResponseErrorCode?(): McpFatalResponseErrorCode | null;
  isClosed?(): boolean;
  listTools(signal?: AbortSignal): Promise<McpRuntimeInventoryTool[]>;
  ping(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  serverEvidence?(): AiqsaMcpServerEvidence | null;
};

export type McpRuntimeSessionFactory = {
  create(input: McpRuntimeLaunch & { onToolsChanged(): void }): Promise<McpRuntimeSession>;
};

export type McpRuntimeCoordinatorRepository = {
  deleteDrainedGeneration(generationId: string): Promise<boolean>;
  finalizeDeletedServers(): Promise<number>;
  listDrainedGenerationIds(): Promise<string[]>;
  listGenerationFingerprints?(): Promise<string[]>;
  loadAcceptedGeneration(generationId: string, now: Date): Promise<McpRuntimeLaunch | null>;
  markFailed(input: {
    errorCode: string;
    fingerprint: string;
    generationId: string;
    now: Date;
  }): Promise<boolean>;
  markReady(input: {
    fingerprint: string;
    generationId: string;
    inventory: { tools: McpRuntimeInventoryTool[]; version: 1 };
    now: Date;
  }): Promise<boolean>;
  markStarting(input: { fingerprint: string; generationId: string; now: Date }): Promise<boolean>;
  synchronizeDesired(input: {
    now: Date;
    onDemand?: boolean;
    serverIds?: readonly string[];
    userId?: string;
  }): Promise<McpRuntimeLaunch[]>;
  touchLastUsed(generationId: string, now: Date): Promise<void>;
};

export type McpRuntimeLifecycle = {
  cleanupOrphans(keepGenerationTokens: readonly string[]): Promise<void>;
};

type LiveRuntime = {
  disabledToolNames: ReadonlySet<string>;
  enabledToolNames: ReadonlySet<string>;
  evictionErrorCode: string | null;
  fingerprint: string;
  local: boolean;
  lastProtocolSuccessAt: number;
  redactionValues: readonly string[];
  repositoryStateWrite: Promise<boolean> | null;
  session: McpRuntimeSession;
};

function effectiveRuntimeTools(
  tools: readonly McpRuntimeInventoryTool[],
  disabledToolNames: ReadonlySet<string>
): McpRuntimeInventoryTool[] {
  return tools.filter((tool) => !disabledToolNames.has(tool.name));
}

function assertInventoryDoesNotExposeCredentials(
  tools: readonly McpRuntimeInventoryTool[],
  staticSecrets: readonly string[],
  session: McpRuntimeSession
): void {
  let dynamicSecrets: readonly string[] = [];
  try {
    dynamicSecrets = session.exactKnownSecrets?.() ?? [];
  } catch {
    throw new McpClientSessionError({
      code: "mcp_inventory_secret_exposed",
      operation: "list_tools"
    });
  }
  const serialized = JSON.stringify(tools);
  const secrets = new Set([...staticSecrets, ...dynamicSecrets].filter(Boolean));
  if ([...secrets].some((secret) => serialized.includes(secret))) {
    throw new McpClientSessionError({
      code: "mcp_inventory_secret_exposed",
      operation: "list_tools"
    });
  }
}

type RefreshRuntime = {
  fingerprint: string;
  promise: Promise<void>;
  rerun: boolean;
};

type StartingRuntime = {
  fingerprint: string;
  promise: Promise<void>;
};

const DEFAULT_INTERVAL_MS = 30_000;
const MAX_PARALLEL_STARTS = 4;
export const MCP_HEALTH_CADENCE_MS = 30_000;
export const MCP_HEALTH_DEADLINE_MS = 2_000;
const MAX_PARALLEL_PROBES = 4;
type HealthProbe = { runtime: LiveRuntime; controller: AbortController | null };
const RESPONSE_LIMIT_ERROR_CODES: ReadonlySet<McpClientSessionError["code"]> = new Set([
  "mcp_call_result_too_large",
  "mcp_initialize_response_too_large",
  "mcp_inventory_response_too_large",
  "mcp_response_too_large"
]);

async function mapLimit<Value>(
  values: Value[],
  limit: number,
  operation: (value: Value) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      await operation(values[index]!);
    }
  });
  await Promise.all(workers);
}

function stableRuntimeError(error: unknown): string {
  if (error instanceof ToolHiveClientError && error.code === "toolhive_artifact_missing") {
    return "mcp_artifact_missing";
  }
  if (error instanceof McpClientSessionError && RESPONSE_LIMIT_ERROR_CODES.has(error.code)) {
    return error.code;
  }
  if (error instanceof Error) {
    if (error.name === "AbortError" || /timed?\s*out|timeout/iu.test(error.message)) return "mcp_timeout";
    if (/unauthori[sz]ed|authorization|required|\b401\b|\b403\b/iu.test(error.message)) {
      return "mcp_authorization_required";
    }
    if (/invalid.*tool|schema|cursor|inventory/iu.test(error.message)) return "mcp_inventory_invalid";
  }
  return "mcp_connect_failed";
}

function isClosedSession(session: McpRuntimeSession): boolean {
  try {
    return session.isClosed?.() === true;
  } catch {
    return true;
  }
}

function fatalResponseErrorCode(session: McpRuntimeSession): McpFatalResponseErrorCode | null {
  try {
    const code = session.fatalResponseErrorCode?.() ?? null;
    return code && RESPONSE_LIMIT_ERROR_CODES.has(code) ? code : null;
  } catch {
    return null;
  }
}

function closedSessionErrorCode(session: McpRuntimeSession): string {
  return fatalResponseErrorCode(session) ?? "mcp_connect_failed";
}

function isNonresponsiveLocalCall(error: unknown, signal: AbortSignal | undefined): boolean {
  if (error instanceof McpClientSessionError && error.code === "mcp_request_timeout") return true;
  return error instanceof McpClientSessionError && error.code === "mcp_request_cancelled" &&
    signal?.aborted === true && signal.reason instanceof Error &&
    /timed?\s*out|timeout/iu.test(signal.reason.message);
}

export class McpRuntimeCoordinator {
  readonly #intervalMs: number;
  readonly #live = new Map<string, LiveRuntime>();
  readonly #now: () => Date;
  readonly #refreshes = new Map<string, RefreshRuntime>();
  readonly #repository: McpRuntimeCoordinatorRepository;
  readonly #runtimeLifecycle: McpRuntimeLifecycle | null;
  readonly #sessions: McpRuntimeSessionFactory;
  readonly #starts = new Map<string, StartingRuntime>();
  readonly #healthProbes = new Map<string, HealthProbe>();
  #activeProbes = 0;
  #pendingAll = false;
  readonly #pendingUsers = new Set<string>();
  #runPromise: Promise<void> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #healthTimer: ReturnType<typeof setTimeout> | null = null;

  async #evictFailedRuntime(
    generationId: string,
    runtime: LiveRuntime,
    errorCode: string,
    cleanup: "close" | "dispose" = "dispose"
  ): Promise<boolean> {
    if (this.#live.get(generationId) !== runtime) return false;
    runtime.evictionErrorCode = errorCode;
    this.#live.delete(generationId);
    this.#discardHealthProbe(generationId, runtime);
    const repositoryStateWrite = runtime.repositoryStateWrite;
    const cleanupPromise = cleanup === "dispose"
      ? runtime.session.dispose?.() ?? runtime.session.close()
      : runtime.session.close();
    const failed = (async () => {
      await repositoryStateWrite?.catch(() => undefined);
      await this.#repository.markFailed({
        errorCode,
        fingerprint: runtime.fingerprint,
        generationId,
        now: this.#now()
      });
    })();
    await Promise.allSettled([
      cleanupPromise,
      failed
    ]);
    return true;
  }

  constructor(input: {
    intervalMs?: number;
    now?: () => Date;
    repository: McpRuntimeCoordinatorRepository;
    runtimeLifecycle?: McpRuntimeLifecycle;
    sessions: McpRuntimeSessionFactory;
  }) {
    this.#intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#now = input.now ?? (() => new Date());
    this.#repository = input.repository;
    this.#runtimeLifecycle = input.runtimeLifecycle ?? null;
    this.#sessions = input.sessions;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.kick(), this.#intervalMs);
    this.#timer.unref?.();
    this.#scheduleHealthCheck();
    this.kick();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#healthTimer) clearTimeout(this.#healthTimer);
    this.#healthTimer = null;
    await this.#runPromise?.catch(() => undefined);
    await Promise.allSettled([...this.#starts.values()].map((runtime) => runtime.promise));
    const sessions = [...this.#live.values()].map((runtime) => runtime.session);
    this.#live.clear();
    for (const probe of this.#healthProbes.values()) probe.controller?.abort();
    this.#healthProbes.clear();
    await Promise.allSettled(sessions.map((session) => session.close()));
  }

  kick(userId?: string): void {
    if (userId) this.#pendingUsers.add(userId);
    else this.#pendingAll = true;
    if (!this.#runPromise) {
      this.#runPromise = Promise.resolve()
        .then(() => this.#drainKicks())
        .finally(() => {
          this.#runPromise = null;
          if (this.#pendingAll || this.#pendingUsers.size) this.kick();
        });
      // Timer- and mutation-triggered kicks are best effort. Explicit
      // reconcileNow callers still observe the same rejection.
      void this.#runPromise.catch(() => undefined);
    }
  }

  async reconcileNow(userId?: string): Promise<void> {
    if (userId) this.#pendingUsers.add(userId);
    else this.#pendingAll = true;
    if (!this.#runPromise) {
      this.kick(userId);
    }
    await this.#runPromise;
  }

  async ensureUserServersReady(userId: string, serverIds: readonly string[]): Promise<void> {
    const uniqueServerIds = [...new Set(serverIds)];
    if (uniqueServerIds.length === 0) return;
    const launches = await this.#repository.synchronizeDesired({
      now: this.#now(),
      onDemand: true,
      serverIds: uniqueServerIds,
      userId
    });
    await this.#reconcileLaunches(launches);
    await this.#drainUnused();
  }

  async callTool(input: {
    arguments: Record<string, unknown>;
    generationId: string;
    inputSchema: Record<string, unknown>;
    name: string;
    signal?: AbortSignal;
  }): Promise<AiqsaMcpToolCallResult> {
    const runtime = this.#live.get(input.generationId);
    if (!runtime) throw new Error("mcp_runtime_not_ready");
    if (!runtime.enabledToolNames.has(input.name)) {
      throw new McpClientSessionError({ code: "mcp_tool_not_available", operation: "call_tool" });
    }
    validateMcpToolArguments(input.inputSchema, input.arguments);
    await this.#repository.touchLastUsed(input.generationId, this.#now());
    try {
      const result = await runtime.session.callTool({
        arguments: input.arguments,
        name: input.name,
        ...(input.signal ? { signal: input.signal } : {})
      });
      return redactMcpToolCallResult(result, runtime.redactionValues);
    } catch (error) {
      const fatalErrorCode = fatalResponseErrorCode(runtime.session);
      if (fatalErrorCode) {
        await this.#evictFailedRuntime(input.generationId, runtime, fatalErrorCode);
      } else if (isClosedSession(runtime.session)) {
        await this.#evictFailedRuntime(input.generationId, runtime, "mcp_connect_failed");
      } else if (runtime.local && isNonresponsiveLocalCall(error, input.signal) &&
        this.#live.get(input.generationId) === runtime) {
        await this.#evictFailedRuntime(input.generationId, runtime, "mcp_timeout");
      }
      throw error;
    }
  }

  hasLiveGeneration(generationId: string): boolean {
    const runtime = this.#live.get(generationId);
    return runtime !== undefined && !isClosedSession(runtime.session);
  }

  /** A prompt snapshot; renews only an already-owned session, never starts one. */
  operationalStatus(generationId: string): McpOperationalStatus {
    const runtime = this.#live.get(generationId);
    if (!runtime) return this.#starts.has(generationId) ? "checking" : "inactive";
    if (isClosedSession(runtime.session)) {
      void this.#evictFailedRuntime(generationId, runtime, closedSessionErrorCode(runtime.session))
        .catch(() => undefined);
      return "inactive";
    }
    const age = this.#now().getTime() - runtime.lastProtocolSuccessAt;
    if (age < 0 || age >= MCP_HEALTH_CADENCE_MS || this.#healthProbes.has(generationId)) {
      if (!this.#healthProbes.has(generationId)) {
        this.#healthProbes.set(generationId, { runtime, controller: null });
        this.#drainHealthProbes();
      }
      return "checking";
    }
    return this.#refreshes.has(generationId) ? "checking" : "active";
  }

  #discardHealthProbe(generationId: string, runtime: LiveRuntime): void {
    const probe = this.#healthProbes.get(generationId);
    if (probe?.runtime !== runtime) return;
    this.#healthProbes.delete(generationId);
    probe.controller?.abort();
  }

  #scheduleHealthCheck(): void {
    if (this.#healthTimer) clearTimeout(this.#healthTimer);
    this.#healthTimer = null;
    if (!this.#timer) return;
    let dueAt = Infinity;
    for (const [generationId, runtime] of this.#live) {
      if (!this.#healthProbes.has(generationId) && !isClosedSession(runtime.session)) {
        dueAt = Math.min(dueAt, runtime.lastProtocolSuccessAt + MCP_HEALTH_CADENCE_MS);
      }
    }
    if (!Number.isFinite(dueAt)) return;
    this.#healthTimer = setTimeout(() => {
      this.#healthTimer = null;
      for (const generationId of this.#live.keys()) this.operationalStatus(generationId);
      this.#scheduleHealthCheck();
    }, Math.max(1, dueAt - this.#now().getTime()));
    this.#healthTimer.unref?.();
  }

  #drainHealthProbes(): void {
    for (const [generationId, probe] of this.#healthProbes) {
      if (this.#activeProbes >= MAX_PARALLEL_PROBES) return;
      if (probe.controller) continue;
      if (this.#live.get(generationId) !== probe.runtime) {
        this.#healthProbes.delete(generationId);
        continue;
      }
      const controller = new AbortController();
      probe.controller = controller;
      this.#activeProbes += 1;
      void this.#probe(generationId, probe, controller).finally(() => {
        if (this.#healthProbes.get(generationId) === probe) this.#healthProbes.delete(generationId);
        this.#activeProbes -= 1;
        this.#drainHealthProbes();
        this.#scheduleHealthCheck();
      });
    }
  }

  async #probe(generationId: string, probe: HealthProbe, controller: AbortController): Promise<void> {
    const runtime = probe.runtime;
    const timeoutError = new McpClientSessionError({ code: "mcp_request_timeout", operation: "ping" });
    const timer = setTimeout(() => controller.abort(timeoutError), MCP_HEALTH_DEADLINE_MS);
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([
        Promise.resolve().then(() => runtime.session.ping({
          signal: controller.signal, timeoutMs: MCP_HEALTH_DEADLINE_MS
        })),
        cancelled
      ]);
      if (this.#live.get(generationId) !== runtime || this.#healthProbes.get(generationId) !== probe) return;
      if (isClosedSession(runtime.session)) throw new Error("mcp_session_closed");
      runtime.lastProtocolSuccessAt = this.#now().getTime();
    } catch (error) {
      // Eviction removes live proof immediately; cleanup does not hold a probe slot.
      if (this.#live.get(generationId) === runtime) {
        void this.#evictFailedRuntime(generationId, runtime, stableRuntimeError(error)).catch(() => undefined);
      }
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
    }
  }

  async ensureAcceptedGeneration(generationId: string): Promise<boolean> {
    const live = this.#live.get(generationId);
    if (live) {
      if (!isClosedSession(live.session)) return true;
      await this.#evictFailedRuntime(generationId, live, closedSessionErrorCode(live.session));
      return false;
    }
    const starting = this.#starts.get(generationId);
    if (starting) {
      await starting.promise;
      const started = this.#live.get(generationId);
      if (started) {
        if (!isClosedSession(started.session)) return true;
        await this.#evictFailedRuntime(
          generationId,
          started,
          closedSessionErrorCode(started.session)
        );
        return false;
      }
    }
    const launch = await this.#repository.loadAcceptedGeneration(generationId, this.#now());
    if (!launch) return false;
    await this.#start(launch);
    const restored = this.#live.get(generationId);
    return restored?.fingerprint === launch.fingerprint && !isClosedSession(restored.session);
  }

  async #drainKicks(): Promise<void> {
    while (this.#pendingAll || this.#pendingUsers.size) {
      const all = this.#pendingAll;
      const users = all ? [] : [...this.#pendingUsers];
      this.#pendingAll = false;
      this.#pendingUsers.clear();
      if (all) {
        await this.#reconcileScope(undefined);
      } else {
        for (const userId of users) await this.#reconcileScope(userId);
      }
    }
  }

  async #reconcileScope(userId?: string): Promise<void> {
    const now = this.#now();
    const launches = await this.#repository.synchronizeDesired({
      now,
      ...(userId ? { userId } : {})
    });
    await this.#reconcileLaunches(launches);
    await this.#drainUnused();
    for (const generationId of this.#live.keys()) this.operationalStatus(generationId);
  }

  async #reconcileLaunches(launches: McpRuntimeLaunch[]): Promise<void> {
    await mapLimit(launches, MAX_PARALLEL_STARTS, async (launch) => {
      const live = this.#live.get(launch.generationId);
      if (live && isClosedSession(live.session)) {
        await this.#evictFailedRuntime(
          launch.generationId,
          live,
          closedSessionErrorCode(live.session)
        );
        return;
      }
      if (live?.fingerprint === launch.fingerprint) {
        if (launch.inventoryRefreshRequired) {
          await this.#refresh(launch.generationId, launch.fingerprint);
        }
        return;
      }
      if (live) {
        this.#live.delete(launch.generationId);
        this.#discardHealthProbe(launch.generationId, live);
        await live.session.close().catch(() => undefined);
      }
      await this.#start(launch);
    });
  }

  #start(launch: McpRuntimeLaunch): Promise<void> {
    const active = this.#starts.get(launch.generationId);
    if (active) {
      return active.fingerprint === launch.fingerprint
        ? active.promise
        : active.promise.then(() => this.#start(launch));
    }
    const starting: StartingRuntime = {
      fingerprint: launch.fingerprint,
      promise: Promise.resolve()
    };
    starting.promise = this.#performStart(launch).finally(() => {
      if (this.#starts.get(launch.generationId) === starting) {
        this.#starts.delete(launch.generationId);
      }
    });
    this.#starts.set(launch.generationId, starting);
    return starting.promise;
  }

  async #performStart(launch: McpRuntimeLaunch): Promise<void> {
    const live = this.#live.get(launch.generationId);
    if (live && isClosedSession(live.session)) {
      await this.#evictFailedRuntime(
        launch.generationId,
        live,
        closedSessionErrorCode(live.session)
      );
      return;
    }
    if (live?.fingerprint === launch.fingerprint) return;
    if (live) {
      this.#live.delete(launch.generationId);
      this.#discardHealthProbe(launch.generationId, live);
      await live.session.close().catch(() => undefined);
    }
    const now = this.#now();
    if (launch.retryAt && launch.retryAt > now) return;
    if (!(await this.#repository.markStarting({
      fingerprint: launch.fingerprint,
      generationId: launch.generationId,
      now
    }))) return;

    let session: McpRuntimeSession | null = null;
    try {
      session = await this.#sessions.create({
        ...launch,
        onToolsChanged: () => {
          void this.#refresh(launch.generationId, launch.fingerprint, true);
        }
      });
      const tools = await session.listTools();
      const protocolSuccessAt = this.#now().getTime();
      if (isClosedSession(session)) throw new Error("mcp_session_closed");
      assertInventoryDoesNotExposeCredentials(tools, launch.redactionValues, session);
      const disabledToolNames = new Set(launch.disabledToolNames ?? []);
      const effectiveTools = effectiveRuntimeTools(tools, disabledToolNames);
      const accepted = await this.#repository.markReady({
        fingerprint: launch.fingerprint,
        generationId: launch.generationId,
        inventory: { tools: effectiveTools, version: 1 },
        now: this.#now()
      });
      if (!accepted) {
        await session.close().catch(() => undefined);
        return;
      }
      if (isClosedSession(session)) throw new Error("mcp_session_closed");
      this.#live.set(launch.generationId, {
        disabledToolNames,
        enabledToolNames: new Set(effectiveTools.map((tool) => tool.name)),
        evictionErrorCode: null,
        fingerprint: launch.fingerprint,
        local: Boolean(launch.toolHive),
        lastProtocolSuccessAt: protocolSuccessAt,
        redactionValues: [...launch.redactionValues],
        repositoryStateWrite: null,
        session
      });
      this.#scheduleHealthCheck();
    } catch (error) {
      const errorCode = session
        ? fatalResponseErrorCode(session) ?? stableRuntimeError(error)
        : stableRuntimeError(error);
      await session?.close().catch(() => undefined);
      await this.#repository.markFailed({
        errorCode,
        fingerprint: launch.fingerprint,
        generationId: launch.generationId,
        now: this.#now()
      });
    }
  }

  #refresh(generationId: string, fingerprint: string, rerunIfActive = false): Promise<void> {
    const active = this.#refreshes.get(generationId);
    if (active) {
      if (active.fingerprint === fingerprint && rerunIfActive) active.rerun = true;
      return active.fingerprint === fingerprint
        ? active.promise
        : active.promise.then(() => this.#refresh(generationId, fingerprint, rerunIfActive));
    }

    const refresh: RefreshRuntime = {
      fingerprint,
      promise: Promise.resolve(),
      rerun: false
    };
    refresh.promise = (async () => {
      do {
        refresh.rerun = false;
        if (!(await this.#performRefresh(generationId, fingerprint))) {
          refresh.rerun = false;
        }
      } while (refresh.rerun);
    })().finally(() => {
      if (this.#refreshes.get(generationId) === refresh) {
        this.#refreshes.delete(generationId);
      }
    });
    this.#refreshes.set(generationId, refresh);
    return refresh.promise;
  }

  async #performRefresh(generationId: string, fingerprint: string): Promise<boolean> {
    const live = this.#live.get(generationId);
    if (!live || live.fingerprint !== fingerprint) return false;
    if (isClosedSession(live.session)) {
      await this.#evictFailedRuntime(
        generationId,
        live,
        closedSessionErrorCode(live.session)
      );
      return false;
    }
    try {
      const startingWrite = this.#repository.markStarting({
        fingerprint,
        generationId,
        now: this.#now()
      });
      live.repositoryStateWrite = startingWrite;
      let started: boolean;
      try {
        started = await startingWrite;
      } finally {
        if (live.repositoryStateWrite === startingWrite) live.repositoryStateWrite = null;
      }
      if (!started) {
        if (live.evictionErrorCode !== null) return false;
        if (this.#live.get(generationId) === live) this.#live.delete(generationId);
        await live.session.close().catch(() => undefined);
        return false;
      }
      if (this.#live.get(generationId) !== live) {
        if (live.evictionErrorCode !== null) return false;
        await this.#repository.markFailed({
          errorCode: "mcp_connect_failed",
          fingerprint,
          generationId,
          now: this.#now()
        });
        return false;
      }
      const tools = await live.session.listTools();
      const protocolSuccessAt = this.#now().getTime();
      if (isClosedSession(live.session)) throw new Error("mcp_session_closed");
      assertInventoryDoesNotExposeCredentials(tools, live.redactionValues, live.session);
      const effectiveTools = effectiveRuntimeTools(tools, live.disabledToolNames);
      if (this.#live.get(generationId) !== live) return false;
      const readinessWrite = this.#repository.markReady({
        fingerprint,
        generationId,
        inventory: { tools: effectiveTools, version: 1 },
        now: this.#now()
      });
      live.repositoryStateWrite = readinessWrite;
      let accepted: boolean;
      try {
        accepted = await readinessWrite;
      } finally {
        if (live.repositoryStateWrite === readinessWrite) live.repositoryStateWrite = null;
      }
      if (!accepted) {
        if (this.#live.get(generationId) === live) this.#live.delete(generationId);
        await live.session.close().catch(() => undefined);
        return false;
      }
      if (this.#live.get(generationId) !== live) {
        if (live.evictionErrorCode !== null) return false;
        await this.#repository.markFailed({
          errorCode: "mcp_connect_failed",
          fingerprint,
          generationId,
          now: this.#now()
        });
        return false;
      }
      if (isClosedSession(live.session)) throw new Error("mcp_session_closed");
      live.enabledToolNames = new Set(effectiveTools.map((tool) => tool.name));
      live.lastProtocolSuccessAt = protocolSuccessAt;
      this.#scheduleHealthCheck();
      return true;
    } catch (error) {
      if (live.evictionErrorCode !== null) return false;
      const fatalErrorCode = fatalResponseErrorCode(live.session);
      const errorCode = fatalErrorCode ?? stableRuntimeError(error);
      if (this.#live.get(generationId) === live) {
        await this.#evictFailedRuntime(
          generationId,
          live,
          errorCode,
          fatalErrorCode !== null || isClosedSession(live.session) ? "dispose" : "close"
        );
        return false;
      }
      await live.session.close().catch(() => undefined);
      await this.#repository.markFailed({
        errorCode,
        fingerprint,
        generationId,
        now: this.#now()
      });
      return false;
    }
  }

  async #drainUnused(): Promise<void> {
    for (const generationId of await this.#repository.listDrainedGenerationIds()) {
      const live = this.#live.get(generationId);
      if (!await this.#repository.deleteDrainedGeneration(generationId)) continue;
      if (!live) continue;
      this.#live.delete(generationId);
      this.#discardHealthProbe(generationId, live);
      await (live.session.dispose?.() ?? live.session.close()).catch(() => undefined);
    }
    await this.#repository.finalizeDeletedServers();
    if (this.#runtimeLifecycle && this.#repository.listGenerationFingerprints) {
      const retained = await this.#repository.listGenerationFingerprints();
      await this.#runtimeLifecycle.cleanupOrphans(retained).catch(() => undefined);
    }
  }
}
