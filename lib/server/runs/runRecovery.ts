import type { ModelRunUsage } from "../../domain/modelRunEvents";
import type { ProviderAdapter, ProviderRunRefreshResult } from "../providers/types";
import {
  appendStoredRunEvents,
  finalizeRunCompletion,
  usageAttributionsWithEstimatedCost
} from "./runFinalization";
import type { RunRepository } from "./runRepositoryContract";

export const activeRunStaleMs = 10 * 60 * 1000;

export type RunRecoveryRegistry = Readonly<{
  has(runId: string): boolean;
  ids(): readonly string[];
}>;

export type RunRecoveryRepository = Pick<
  RunRepository,
  | "appendRunEvent"
  | "completeRun"
  | "failRun"
  | "findStaleActiveRunsForUser"
  | "getRunControlForUser"
  | "loadModelPricing"
  | "nextRunEventSequence"
  | "settleRecoveredRunError"
  | "sweepBootOrphanedRuns"
  | "updateRunProviderResponseId"
>;

export type RunRecoveryDeps = Readonly<{
  providers: Readonly<Record<string, ProviderAdapter>>;
  registry: RunRecoveryRegistry;
  repository: RunRecoveryRepository;
}>;

type ProcessBootSweepState = {
  bootedAt: Date;
  promise?: Promise<void>;
};

const globalForRunRecovery = globalThis as unknown as {
  __aiqsaRunBootSweepState?: ProcessBootSweepState;
  __aiqsaRunRefreshPromises?: Map<string, Promise<void>>;
};
const processBootSweepState = globalForRunRecovery.__aiqsaRunBootSweepState ?? {
  bootedAt: new Date(performance.timeOrigin)
};
globalForRunRecovery.__aiqsaRunBootSweepState = processBootSweepState;
const runRefreshPromises =
  globalForRunRecovery.__aiqsaRunRefreshPromises ?? new Map<string, Promise<void>>();
globalForRunRecovery.__aiqsaRunRefreshPromises = runRefreshPromises;

export function resetBootOrphanSweepForTest(bootedAt = new Date()): void {
  processBootSweepState.bootedAt = bootedAt;
  processBootSweepState.promise = undefined;
}

function isActiveRunStatus(status: string): boolean {
  return status === "streaming" || status === "queued" || status === "in_progress";
}

function isRefreshableRun(control: Readonly<{ recoverySettled?: boolean; status: string }>): boolean {
  return isActiveRunStatus(control.status) || (control.status === "error" && !control.recoverySettled);
}

function reportedUsage(refreshed: ProviderRunRefreshResult): ModelRunUsage | null {
  if (refreshed.result) {
    return refreshed.result.usage;
  }

  for (let index = refreshed.events.length - 1; index >= 0; index -= 1) {
    const event = refreshed.events[index];
    if (event?.type === "usage") {
      return event.data;
    }
  }

  return null;
}

async function recoveredUsageAttributions(
  deps: RunRecoveryDeps,
  control: Readonly<{ modelId: string; provider: string }>,
  usage: ModelRunUsage | null
) {
  if (!usage) {
    return [];
  }

  return usageAttributionsWithEstimatedCost(deps.repository, [
    {
      modelId: control.modelId,
      provider: control.provider,
      usage
    }
  ]);
}

export async function sweepBootOrphanedRunsOnce(
  deps: Pick<RunRecoveryDeps, "registry" | "repository">
): Promise<void> {
  if (processBootSweepState.promise) {
    await processBootSweepState.promise;
    return;
  }

  const promise = deps.repository
    .sweepBootOrphanedRuns({
      createdBefore: processBootSweepState.bootedAt,
      liveRunIds: [...deps.registry.ids()]
    })
    .then(() => undefined)
    .catch((error: unknown) => {
      if (processBootSweepState.promise === promise) {
        processBootSweepState.promise = undefined;
      }
      throw error;
    });

  processBootSweepState.promise = promise;
  await promise;
}

async function refreshProviderRunOnce(
  deps: RunRecoveryDeps,
  runId: string,
  userId: string
): Promise<void> {
  const control = await deps.repository.getRunControlForUser(runId, userId);
  if (!control || !isRefreshableRun(control) || !control.providerResponseId) {
    return;
  }

  if (deps.registry.has(runId)) {
    return;
  }

  const adapter = deps.providers[control.provider];
  if (!adapter?.refresh) {
    return;
  }

  const refreshed = await adapter.refresh(control.providerResponseId).catch(async (error) => {
    const latest = await deps.repository.getRunControlForUser(runId, userId);
    if (!latest || !isActiveRunStatus(latest.status) || !latest.assistantMessageId) {
      return null;
    }

    const payload = {
      code: "provider_refresh_failed",
      message: error instanceof Error ? error.message : "Provider refresh failed"
    };
    await deps.repository.failRun(runId, latest.assistantMessageId, payload);

    return null;
  });

  if (!refreshed) {
    return;
  }

  const latestBeforeAppend = await deps.repository.getRunControlForUser(runId, userId);
  if (!latestBeforeAppend || !isRefreshableRun(latestBeforeAppend)) {
    return;
  }

  const refreshedProviderResponseId =
    refreshed.result?.providerResponseId ?? refreshed.providerResponseId ?? latestBeforeAppend.providerResponseId;
  if (refreshedProviderResponseId && refreshedProviderResponseId !== latestBeforeAppend.providerResponseId) {
    const publication = await deps.repository.updateRunProviderResponseId(runId, refreshedProviderResponseId);
    if (publication === "cancelled") {
      await adapter.cancel?.(refreshedProviderResponseId).catch(() => undefined);
      return;
    }
    if (publication === "terminal") {
      return;
    }
  }

  if (!refreshed.terminal) {
    const sequence = { value: await deps.repository.nextRunEventSequence(runId) };
    await appendStoredRunEvents({
      events: refreshed.events,
      repository: deps.repository,
      runId,
      sequence
    });
    return;
  }

  const latestBeforeFinalize = await deps.repository.getRunControlForUser(runId, userId);
  if (!latestBeforeFinalize || !isRefreshableRun(latestBeforeFinalize)) {
    return;
  }

  if ((refreshed.result?.toolCalls?.length ?? 0) > 0) {
    const payload = {
      code: "tool_loop_recovery_required",
      message: "The provider response contains outstanding tool calls and cannot be finalized as an answer. Retry the run."
    };
    const usageAttributions = await recoveredUsageAttributions(
      deps,
      latestBeforeFinalize,
      reportedUsage(refreshed)
    );
    await deps.repository.settleRecoveredRunError({
      error: payload,
      events: [...refreshed.events],
      ...(refreshedProviderResponseId
        ? { providerResponseId: refreshedProviderResponseId }
        : {}),
      runId,
      usageAttributions,
      userId
    });
    return;
  }

  if (refreshed.result && latestBeforeFinalize.assistantMessageId) {
    const completion = await finalizeRunCompletion({
      eventsBeforeTerminal: refreshed.events,
      repository: deps.repository,
      result: {
        ...refreshed.result,
        providerResponseId: refreshedProviderResponseId ?? undefined
      },
      run: {
        assistantMessageId: latestBeforeFinalize.assistantMessageId,
        chatId: latestBeforeFinalize.chatId,
        modelId: latestBeforeFinalize.modelId,
        provider: latestBeforeFinalize.provider,
        runId,
        userId
      }
    });
    if (completion.status === "not_completed") {
      return;
    }

    return;
  }

  const payload = refreshed.error ?? {
    code: "provider_terminal_response_invalid",
    message: "The provider returned a terminal response without a final result."
  };
  const usageAttributions = await recoveredUsageAttributions(
    deps,
    latestBeforeFinalize,
    reportedUsage(refreshed)
  );
  await deps.repository.settleRecoveredRunError({
    error: payload,
    events: [...refreshed.events],
    ...(refreshedProviderResponseId
      ? { providerResponseId: refreshedProviderResponseId }
      : {}),
    runId,
    usageAttributions,
    userId
  });
}

export async function refreshProviderRunIfNeeded(
  deps: RunRecoveryDeps,
  runId: string,
  userId: string
): Promise<void> {
  const existing = runRefreshPromises.get(runId);
  if (existing) {
    await existing;
    return;
  }

  const refresh = refreshProviderRunOnce(deps, runId, userId);
  runRefreshPromises.set(runId, refresh);
  try {
    await refresh;
  } finally {
    if (runRefreshPromises.get(runId) === refresh) {
      runRefreshPromises.delete(runId);
    }
  }
}

export async function reconcileStaleRuns(
  deps: RunRecoveryDeps,
  input: Readonly<{
    chatId?: string;
    now?: Date;
    runId?: string;
    userId: string;
  }>
): Promise<void> {
  const staleBefore = new Date((input.now ?? new Date()).getTime() - activeRunStaleMs);
  const staleRuns = await deps.repository.findStaleActiveRunsForUser({
    chatId: input.chatId,
    runId: input.runId,
    staleBefore,
    userId: input.userId
  });

  for (const run of staleRuns) {
    if (deps.registry.has(run.id)) {
      continue;
    }

    const adapter = deps.providers[run.provider];
    if (run.providerResponseId && adapter?.refresh) {
      await refreshProviderRunIfNeeded(deps, run.id, input.userId);
      continue;
    }

    if (!run.assistantMessageId) {
      continue;
    }

    const payload = {
      code: "run_orphaned",
      message: "Run stopped reporting progress and was marked failed."
    };
    await deps.repository.failRun(run.id, run.assistantMessageId, payload);
  }
}
