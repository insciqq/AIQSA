import {
  McpClientSessionError,
  validateMcpToolArguments,
  type AiqsaMcpToolCallResult
} from "./clientSession";
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
  listTools(signal?: AbortSignal): Promise<McpRuntimeInventoryTool[]>;
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
  synchronizeDesired(input: { now: Date; userId?: string }): Promise<McpRuntimeLaunch[]>;
  touchLastUsed(generationId: string, now: Date): Promise<void>;
};

export type McpRuntimeLifecycle = {
  cleanupOrphans(keepGenerationTokens: readonly string[]): Promise<void>;
};

type LiveRuntime = {
  fingerprint: string;
  local: boolean;
  redactionValues: readonly string[];
  session: McpRuntimeSession;
};

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
  if (error instanceof Error) {
    if (error.name === "AbortError" || /timed?\s*out|timeout/iu.test(error.message)) return "mcp_timeout";
    if (/unauthori[sz]ed|authorization|required|\b401\b|\b403\b/iu.test(error.message)) {
      return "mcp_authorization_required";
    }
    if (/invalid.*tool|schema|cursor|inventory/iu.test(error.message)) return "mcp_inventory_invalid";
  }
  return "mcp_connect_failed";
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
  #pendingAll = false;
  readonly #pendingUsers = new Set<string>();
  #runPromise: Promise<void> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

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
    this.kick();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#runPromise?.catch(() => undefined);
    await Promise.allSettled([...this.#starts.values()].map((runtime) => runtime.promise));
    const sessions = [...this.#live.values()].map((runtime) => runtime.session);
    this.#live.clear();
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

  async callTool(input: {
    arguments: Record<string, unknown>;
    generationId: string;
    inputSchema: Record<string, unknown>;
    name: string;
    signal?: AbortSignal;
  }): Promise<AiqsaMcpToolCallResult> {
    const runtime = this.#live.get(input.generationId);
    if (!runtime) throw new Error("mcp_runtime_not_ready");
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
      if (runtime.local && isNonresponsiveLocalCall(error, input.signal) &&
        this.#live.get(input.generationId) === runtime) {
        this.#live.delete(input.generationId);
        await Promise.allSettled([
          runtime.session.dispose?.() ?? runtime.session.close(),
          this.#repository.markFailed({
            errorCode: "mcp_timeout",
            fingerprint: runtime.fingerprint,
            generationId: input.generationId,
            now: this.#now()
          })
        ]);
      }
      throw error;
    }
  }

  hasLiveGeneration(generationId: string): boolean {
    return this.#live.has(generationId);
  }

  async ensureAcceptedGeneration(generationId: string): Promise<boolean> {
    if (this.#live.has(generationId)) return true;
    const starting = this.#starts.get(generationId);
    if (starting) {
      await starting.promise;
      if (this.#live.has(generationId)) return true;
    }
    const launch = await this.#repository.loadAcceptedGeneration(generationId, this.#now());
    if (!launch) return false;
    await this.#start(launch);
    return this.#live.get(generationId)?.fingerprint === launch.fingerprint;
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
    await mapLimit(launches, MAX_PARALLEL_STARTS, async (launch) => {
      const live = this.#live.get(launch.generationId);
      if (live?.fingerprint === launch.fingerprint) {
        if (launch.inventoryRefreshRequired) {
          await this.#refresh(launch.generationId, launch.fingerprint);
        }
        return;
      }
      if (live) {
        this.#live.delete(launch.generationId);
        await live.session.close().catch(() => undefined);
      }
      await this.#start(launch);
    });
    await this.#drainUnused();
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
    if (live?.fingerprint === launch.fingerprint) return;
    if (live) {
      this.#live.delete(launch.generationId);
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
      assertInventoryDoesNotExposeCredentials(tools, launch.redactionValues, session);
      const accepted = await this.#repository.markReady({
        fingerprint: launch.fingerprint,
        generationId: launch.generationId,
        inventory: { tools, version: 1 },
        now: this.#now()
      });
      if (!accepted) {
        await session.close().catch(() => undefined);
        return;
      }
      this.#live.set(launch.generationId, {
        fingerprint: launch.fingerprint,
        local: Boolean(launch.toolHive),
        redactionValues: [...launch.redactionValues],
        session
      });
    } catch (error) {
      await session?.close().catch(() => undefined);
      await this.#repository.markFailed({
        errorCode: stableRuntimeError(error),
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
    try {
      if (!(await this.#repository.markStarting({
        fingerprint,
        generationId,
        now: this.#now()
      }))) {
        if (this.#live.get(generationId) === live) this.#live.delete(generationId);
        await live.session.close().catch(() => undefined);
        return false;
      }
      const tools = await live.session.listTools();
      assertInventoryDoesNotExposeCredentials(tools, live.redactionValues, live.session);
      if (this.#live.get(generationId) !== live) return false;
      const accepted = await this.#repository.markReady({
        fingerprint,
        generationId,
        inventory: { tools, version: 1 },
        now: this.#now()
      });
      if (!accepted) {
        if (this.#live.get(generationId) === live) this.#live.delete(generationId);
        await live.session.close().catch(() => undefined);
        return false;
      }
      if (this.#live.get(generationId) !== live) {
        await this.#repository.markFailed({
          errorCode: "mcp_connect_failed",
          fingerprint,
          generationId,
          now: this.#now()
        });
        return false;
      }
      return true;
    } catch (error) {
      if (this.#live.get(generationId) === live) this.#live.delete(generationId);
      await live.session.close().catch(() => undefined);
      await this.#repository.markFailed({
        errorCode: stableRuntimeError(error),
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
      await (live.session.dispose?.() ?? live.session.close()).catch(() => undefined);
    }
    await this.#repository.finalizeDeletedServers();
    if (this.#runtimeLifecycle && this.#repository.listGenerationFingerprints) {
      const retained = await this.#repository.listGenerationFingerprints();
      await this.#runtimeLifecycle.cleanupOrphans(retained).catch(() => undefined);
    }
  }
}
