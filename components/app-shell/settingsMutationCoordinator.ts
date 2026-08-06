import { responseErrorMessage } from "@/components/app-shell/shellFormatting";
import { shellFetch } from "@/components/app-shell/shellApi";
import type { CatalogDefaults } from "@/lib/contracts/catalog";
import type { SearchPlan } from "@/lib/domain/search";
import {
  decodeUpdateSettingsResponse,
  type UserSettingsWire
} from "@/lib/contracts/settings";

export type SettingsDefaultsPatch = Omit<Partial<CatalogDefaults>, "searchPlan"> & {
  searchPlan?: SearchPlan | null;
};

type PendingSettingsPatch = {
  noticeScope: SettingsNoticeScope;
  patch: SettingsDefaultsPatch;
  throughSequence: number;
};

export type SettingsNoticeScope = "general" | "settings";

type SettingsMutationCallbacks = {
  onFailure(error: unknown, retry: () => void, noticeScope: SettingsNoticeScope): void;
  onReconcile(patch: SettingsDefaultsPatch, replaceControlValueKeys: ReadonlySet<string>): void;
  onRecovered(noticeScope: SettingsNoticeScope): void;
};

export type SettingsMutationCoordinator = {
  configure(callbacks: SettingsMutationCallbacks): void;
  enqueue(
    patch: SettingsDefaultsPatch,
    options?: { noticeScope?: SettingsNoticeScope }
  ): Promise<boolean>;
  retry(): void;
};

type SettingsMutationCoordinatorInput = {
  callbacks: SettingsMutationCallbacks;
  send?(patch: SettingsDefaultsPatch): Promise<UserSettingsWire>;
};

type SettingsWaiter = {
  resolve(saved: boolean): void;
  sequence: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeControlValues(
  current: Record<string, unknown> | undefined,
  update: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!current && !update) {
    return undefined;
  }

  const merged: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(update ?? {})) {
    const previous = merged[key];
    merged[key] = isRecord(previous) && isRecord(value) ? { ...previous, ...value } : value;
  }

  return merged;
}

export function mergeSettingsDefaultsPatches(
  current: SettingsDefaultsPatch,
  update: SettingsDefaultsPatch
): SettingsDefaultsPatch {
  const controlValues = mergeControlValues(current.controlValues, update.controlValues);

  return {
    ...current,
    ...update,
    ...(controlValues ? { controlValues } : {})
  };
}

export function applySettingsDefaultsReconciliation(
  current: CatalogDefaults,
  update: SettingsDefaultsPatch,
  replaceControlValueKeys: ReadonlySet<string> = new Set()
): CatalogDefaults {
  const safeUpdate = update.searchPlan === null
    ? Object.fromEntries(Object.entries(update).filter(([key]) => key !== "searchPlan")) as SettingsDefaultsPatch
    : update;
  const merged = mergeSettingsDefaultsPatches(current, safeUpdate) as CatalogDefaults;
  if (!update.controlValues || replaceControlValueKeys.size === 0) {
    return merged;
  }

  const controlValues = { ...merged.controlValues };
  for (const key of replaceControlValueKeys) {
    controlValues[key] = update.controlValues[key] ?? {};
  }

  return {
    ...merged,
    controlValues
  };
}

function requestBody(patch: SettingsDefaultsPatch): Record<string, unknown> {
  return {
    ...(Object.prototype.hasOwnProperty.call(patch, "provider")
      ? { defaultProvider: patch.provider }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "modelId")
      ? { defaultModelId: patch.modelId }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "searchStrategyId") &&
      !Object.prototype.hasOwnProperty.call(patch, "searchPlan")
      ? { defaultSearchStrategyId: patch.searchStrategyId }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "searchPlan")
      ? { defaultSearchPlan: patch.searchPlan }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "showCitations")
      ? { showCitations: patch.showCitations }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "showReasoningBlocks")
      ? { showReasoningBlocks: patch.showReasoningBlocks }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "showToolActivity")
      ? { showToolActivity: patch.showToolActivity }
      : {}),
    ...(patch.controlValues ? { defaultControlValues: patch.controlValues } : {})
  };
}

export async function sendSettingsDefaultsPatch(
  patch: SettingsDefaultsPatch
): Promise<UserSettingsWire> {
  const response = await shellFetch("/api/me/settings", {
    body: JSON.stringify(requestBody(patch)),
    headers: {
      "content-type": "application/json"
    },
    keepalive: true,
    method: "PATCH"
  });

  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, `settings_update_failed_${response.status}`));
  }

  const decoded = decodeUpdateSettingsResponse(await response.json().catch(() => null));
  if (!decoded) {
    throw new Error("settings_malformed");
  }

  return decoded.settings;
}

function reconciledPatch(
  sent: SettingsDefaultsPatch,
  settings: UserSettingsWire
): SettingsDefaultsPatch {
  const patch: SettingsDefaultsPatch = {};

  if (Object.prototype.hasOwnProperty.call(sent, "provider")) {
    patch.provider = settings.defaultProvider;
  }
  if (Object.prototype.hasOwnProperty.call(sent, "modelId")) {
    patch.modelId = settings.defaultModelId;
  }
  if (Object.prototype.hasOwnProperty.call(sent, "searchStrategyId")) {
    patch.searchStrategyId = settings.defaultSearchStrategyId;
  }
  if (Object.prototype.hasOwnProperty.call(sent, "searchPlan")) {
    patch.searchPlan = settings.defaultSearchPlan ?? {
      mode: "all_selected",
      optionIds: settings.defaultSearchStrategyId === "search-disabled"
        ? []
        : [settings.defaultSearchStrategyId]
    };
    if (settings.organizationSearchPlan) {
      patch.organizationSearchPlan = settings.organizationSearchPlan;
    }
    if (settings.searchPreferenceSource) {
      patch.searchPreferenceSource = settings.searchPreferenceSource;
    }
  }
  if (Object.prototype.hasOwnProperty.call(sent, "showCitations")) {
    patch.showCitations = settings.showCitations;
  }
  if (Object.prototype.hasOwnProperty.call(sent, "showReasoningBlocks")) {
    patch.showReasoningBlocks = settings.showReasoningBlocks;
  }
  if (Object.prototype.hasOwnProperty.call(sent, "showToolActivity")) {
    patch.showToolActivity = settings.showToolActivity;
  }
  if (sent.controlValues) {
    patch.controlValues = Object.fromEntries(
      Object.keys(sent.controlValues).map((key) => [key, settings.defaultControlValues[key] ?? {}])
    );
  }

  return patch;
}

export function createSettingsMutationCoordinator({
  callbacks: initialCallbacks,
  send = sendSettingsDefaultsPatch
}: SettingsMutationCoordinatorInput): SettingsMutationCoordinator {
  let callbacks = initialCallbacks;
  let failureOutstanding = false;
  let failureNoticeScope: SettingsNoticeScope = "general";
  let inFlight = false;
  let paused = false;
  let pending: PendingSettingsPatch | null = null;
  let sequence = 0;
  const waiters: SettingsWaiter[] = [];

  function pendingBatch(): PendingSettingsPatch | null {
    return pending;
  }

  function settleWaiters(throughSequence: number, saved: boolean) {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter && waiter.sequence <= throughSequence) {
        waiters.splice(index, 1);
        waiter.resolve(saved);
      }
    }
  }

  async function drain() {
    if (inFlight || paused || !pending) {
      return;
    }

    const batch = pending;
    pending = null;
    inFlight = true;

    try {
      const settings = await send(batch.patch);
      const newerPatch = pendingBatch()?.patch ?? {};
      callbacks.onReconcile(
        mergeSettingsDefaultsPatches(reconciledPatch(batch.patch, settings), newerPatch),
        new Set(Object.keys(batch.patch.controlValues ?? {}))
      );
      settleWaiters(batch.throughSequence, true);
      if (failureOutstanding) {
        failureOutstanding = false;
        callbacks.onRecovered(failureNoticeScope);
      }
    } catch (error) {
      const queued = pendingBatch();
      const combinedNoticeScope =
        batch.noticeScope === "settings" || queued?.noticeScope === "settings"
          ? "settings"
          : "general";
      const retainedNoticeScope = failureOutstanding ? failureNoticeScope : combinedNoticeScope;
      pending = {
        noticeScope: retainedNoticeScope,
        patch: mergeSettingsDefaultsPatches(batch.patch, queued?.patch ?? {}),
        throughSequence: Math.max(batch.throughSequence, queued?.throughSequence ?? 0)
      };
      settleWaiters(pending.throughSequence, false);
      failureOutstanding = true;
      failureNoticeScope = retainedNoticeScope;
      paused = true;
      callbacks.onFailure(error, retry, retainedNoticeScope);
    } finally {
      inFlight = false;
      if (!paused && pending) {
        void drain();
      }
    }
  }

  function retry() {
    if (!paused) {
      return;
    }

    paused = false;
    void drain();
  }

  return {
    configure(nextCallbacks) {
      callbacks = nextCallbacks;
    },
    enqueue(patch, options = {}) {
      sequence += 1;
      pending = {
        noticeScope: options.noticeScope ?? pending?.noticeScope ?? "general",
        patch: mergeSettingsDefaultsPatches(pending?.patch ?? {}, patch),
        throughSequence: sequence
      };

      const settled = new Promise<boolean>((resolve) => {
        waiters.push({ resolve, sequence });
      });
      if (paused) {
        paused = false;
      }
      void drain();

      return settled;
    },
    retry
  };
}
