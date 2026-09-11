"use client";

import {
  discoverAdminCompatibleModels,
  addAdminProviderCatalogModels,
  adminProviderErrorMessage,
  createAdminProviderCredential,
  createAdminProviderModel,
  deleteAdminProviderConnection,
  deleteAdminProviderCredential,
  deleteAdminProviderModel,
  discoverAdminOpenRouterEndpoints,
  discoverAdminOpenRouterModels,
  getAdminProviderConnections,
  runAdminProviderConnectionAction,
  renameAdminProviderModel,
  runAdminProviderModelAction,
  updateAdminProviderConnection,
  updateAdminProviderCredential,
  updateAdminProviderModel,
  type AdminProviderClientError,
  type AdminProviderClientResult
} from "./adminProvidersApi";
import type { AdminProviderModelSaveClientResult } from "./adminProvidersApi";
import type { AdminProviderModelSaveReceipt } from "@/lib/contracts/adminProviderModelSave";
import type { AdminProviderModelPersistence } from "./providers/models/modelSaveReconciliation";
import type {
  AdminCompatibleDiscoveredModel,
  AdminOpenRouterDiscoveredEndpoint,
  AdminOpenRouterDiscoveredModel,
  AdminProviderConnection,
  AdminProviderConnectionConfiguration,
  AdminProviderModelEditGuard,
  AdminProviderModelRename
} from "@/lib/contracts/adminProviders";
import type { AdminProviderSetupProgress } from "@/lib/contracts/adminProviderSetupProgress";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type CatalogOperation = () => Promise<AdminProviderClientResult<AdminProviderConnection[]>>;

export type AdminProviderOperationResult =
  | { ok: true }
  | { error: AdminProviderClientError; message: string; ok: false };

export type AdminProviderModelOperationResult = AdminProviderOperationResult & {
  persistence?: AdminProviderModelPersistence;
};

export type UseAdminProvidersControllerOptions = Readonly<{
  /** Whole-action failures that no form shows inline (toast). */
  onError?(message: string): void;
  onMutationCommitted?(): void | Promise<unknown>;
  /** Whole-action successes (toast). */
  onNotice?(message: string): void;
}>;

type CatalogRunOptions = Readonly<{
  /** Inline forms own the error; the controller only records it. */
  quiet?: boolean;
  reconcileFailure?: boolean;
  scope?: string | null;
}>;

function notifyMutationCommitted(callback: UseAdminProvidersControllerOptions["onMutationCommitted"]): void {
  if (!callback) return;
  void Promise.resolve().then(callback).catch(() => undefined);
}

function failure(error: AdminProviderClientError): Extract<AdminProviderOperationResult, { ok: false }> {
  return { error, message: adminProviderErrorMessage(error), ok: false };
}

/**
 * The one state owner for the provider catalog: every mutation goes through
 * the API client, and the server's catalog response replaces local state so
 * the browser never keeps its own copy of a key or configuration.
 */
export function useAdminProvidersController(
  active: boolean,
  options: UseAdminProvidersControllerOptions = {}
) {
  const [connections, setConnections] = useState<AdminProviderConnection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorBlockers, setErrorBlockers] = useState<ReadonlyArray<{
    count: number;
    kind: string;
  }>>([]);
  const [feedbackConnectionId, setFeedbackConnectionId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busyRef = useRef(false);
  const connectionsRef = useRef<AdminProviderConnection[]>([]);
  const catalogGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const autoLoadAttemptedRef = useRef(false);
  const optionsRef = useRef(options);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);
  useEffect(() => {
    // Effect replay keeps the initial request valid; a real unmount rejects its result.
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const applyConnections = useCallback((next: AdminProviderConnection[]) => {
    connectionsRef.current = next;
    setConnections(next);
  }, []);

  const refresh = useCallback(async () => {
    if (busyRef.current) return false;
    const generation = ++catalogGenerationRef.current;
    setLoading(true);
    setError(null);
    setErrorCode(null);
    setErrorBlockers([]);
    setFeedbackConnectionId(null);
    const result = await getAdminProviderConnections();
    if (!mountedRef.current || generation !== catalogGenerationRef.current) return false;
    setLoading(false);
    setLoaded(true);
    if (!result.ok) {
      setError(adminProviderErrorMessage(result.error));
      setErrorCode(result.error.code);
      setErrorBlockers(result.error.blockers);
      return false;
    }
    applyConnections(result.data);
    return true;
  }, [applyConnections]);

  useEffect(() => {
    if (!active) {
      autoLoadAttemptedRef.current = false;
      return;
    }
    if (!loaded && !loading && !autoLoadAttemptedRef.current) {
      autoLoadAttemptedRef.current = true;
      void refresh();
    }
  }, [active, loaded, loading, refresh]);

  const beginRun = useCallback(() => {
    busyRef.current = true;
    setLoading(false);
    setBusy(true);
    setError(null);
    setErrorCode(null);
    setErrorBlockers([]);
    setFeedbackConnectionId(null);
    setNotice(null);
  }, []);

  const finishFailure = useCallback((
    clientError: AdminProviderClientError,
    runOptions: CatalogRunOptions
  ): AdminProviderOperationResult => {
    const result = failure(clientError);
    busyRef.current = false;
    setBusy(false);
    setError(result.message);
    setErrorCode(clientError.code);
    setErrorBlockers(clientError.blockers);
    setFeedbackConnectionId(runOptions.scope ?? null);
    if (!runOptions.quiet) optionsRef.current.onError?.(result.message);
    return result;
  }, []);

  const finishSuccess = useCallback((
    catalog: AdminProviderConnection[],
    success: string | null,
    runOptions: CatalogRunOptions
  ): AdminProviderOperationResult => {
    busyRef.current = false;
    setBusy(false);
    applyConnections(catalog);
    setErrorCode(null);
    setErrorBlockers([]);
    setFeedbackConnectionId(
      runOptions.scope && catalog.some(({ id }) => id === runOptions.scope)
        ? runOptions.scope
        : null
    );
    setNotice(success);
    if (success !== null) optionsRef.current.onNotice?.(success);
    notifyMutationCommitted(optionsRef.current.onMutationCommitted);
    return { ok: true };
  }, [applyConnections]);

  const runCatalogResult = useCallback(async (
    operation: CatalogOperation,
    success: string | null,
    runOptions: CatalogRunOptions = {}
  ): Promise<AdminProviderOperationResult> => {
    if (busyRef.current) {
      return failure({ blockers: [], code: "provider_admin_busy", resourceIds: [] });
    }
    const generation = ++catalogGenerationRef.current;
    beginRun();
    const result = await operation();
    if (!mountedRef.current || generation !== catalogGenerationRef.current) {
      busyRef.current = false;
      setBusy(false);
      return failure({ blockers: [], code: "provider_admin_superseded", resourceIds: [] });
    }
    if (!result.ok) {
      if (runOptions.reconcileFailure) {
        const latest = await getAdminProviderConnections();
        if (latest.ok) applyConnections(latest.data);
      }
      return finishFailure(result.error, runOptions);
    }
    return finishSuccess(result.data, success, runOptions);
  }, [applyConnections, beginRun, finishFailure, finishSuccess]);

  const runCatalog = useCallback(async (
    operation: CatalogOperation,
    success: string,
    reconcileFailure = false,
    feedbackScope: string | null = null
  ) => (await runCatalogResult(operation, success, { reconcileFailure, scope: feedbackScope })).ok,
  [runCatalogResult]);

  const runModelSave = useCallback(async (
    operation: () => Promise<AdminProviderModelSaveClientResult>,
    connectionId: string,
    modelId: string | null,
    body: { displayName: string } & Partial<AdminProviderModelEditGuard>,
    saved: AdminProviderModelSaveReceipt["saved"]
  ): Promise<AdminProviderModelOperationResult> => {
    if (busyRef.current) return failure({ blockers: [], code: "provider_admin_busy", resourceIds: [] });
    const generation = ++catalogGenerationRef.current;
    beginRun();
    const result = await operation();
    if (!mountedRef.current || generation !== catalogGenerationRef.current) return failure({ blockers: [], code: "provider_admin_superseded", resourceIds: [] });
    const candidate = result.ok ? result.data : result.receipt;
    const receipt = candidate && candidate.connectionId === connectionId &&
      (modelId === null || candidate.modelId === modelId) && candidate.displayName === body.displayName && candidate.saved === saved &&
      candidate.draftVersion === (modelId === null ? 1 : Number(body.expectedDraftVersion) + (saved === "configuration" ? 1 : 0))
      ? candidate : null;
    const latest = await getAdminProviderConnections();
    if (!mountedRef.current || generation !== catalogGenerationRef.current) return failure({ blockers: [], code: "provider_admin_superseded", resourceIds: [] });
    const catalog = latest.ok ? latest.data : null;
    if (catalog) applyConnections(catalog);
    const resolvedId = receipt?.modelId ?? modelId;
    const current = catalog?.find(({ id }) => id === connectionId)?.models.find(({ id }) => id === resolvedId) ?? null;
    const ambiguous = !result.ok && result.status === undefined;
    const persistence: AdminProviderModelPersistence = { receipt, model: receipt || ambiguous ? current : null };
    const nameConfirmed = ambiguous && saved === "name" && current?.displayName === body.displayName &&
      current.draftVersion === body.expectedDraftVersion && current.activeVersion === body.expectedActiveVersion &&
      new Date(current.updatedAt).getTime() > new Date(body.expectedUpdatedAt ?? "").getTime();
    if (catalog && (nameConfirmed || result.ok && receipt &&
      (saved === "name" || receipt.publication === "active" && ["checked", "skipped"].includes(receipt.checks)))) {
      return { ...finishSuccess(catalog, null, { quiet: true, scope: connectionId }), persistence };
    }
    const clientError = !result.ok ? result.error : !receipt
      ? { blockers: [], code: "provider_admin_response_invalid", resourceIds: [] }
      : !latest.ok ? latest.error : { blockers: [], code: "provider_refresh_failed", resourceIds: [] };
    const failed = finishFailure(clientError, { quiet: true, scope: connectionId });
    if (receipt) notifyMutationCommitted(optionsRef.current.onMutationCommitted);
    return { ...failed, persistence };
  }, [applyConnections, beginRun, finishFailure, finishSuccess]);

  /**
   * Background polling (capability checks in progress): replaces the catalog
   * without touching busy, loading or feedback state, and yields to any
   * mutation that started meanwhile.
   */
  const refreshQuietly = useCallback(async () => {
    if (busyRef.current) return false;
    const generation = ++catalogGenerationRef.current;
    const result = await getAdminProviderConnections();
    if (!mountedRef.current || generation !== catalogGenerationRef.current || busyRef.current || !result.ok) return false;
    applyConnections(result.data);
    return true;
  }, [applyConnections]);

  useEffect(() => {
    if (!active || !loaded) return;
    const onFocus = () => {
      if (document.visibilityState !== "hidden") void refreshQuietly();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const timer = window.setInterval(onFocus, 30_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.clearInterval(timer);
    };
  }, [active, loaded, refreshQuietly]);

  const runScopedDiscovery = useCallback(async <T,>(
    operation: () => Promise<AdminProviderClientResult<T>>
  ): Promise<T | null> => {
    const result = await operation();
    return result.ok ? result.data : null;
  }, []);

  /** The server tests and publishes settings and any re-entered keys in one CAS. */
  const saveConnectionSettings = useCallback(async (
    connectionId: string,
    input: Readonly<{
      configuration: AdminProviderConnectionConfiguration;
      credentialSecrets: readonly { credentialId: string; secret: string }[];
      displayName: string;
      expectedDraftVersion: number;
    }>
  ): Promise<AdminProviderOperationResult> => {
    const connection = connectionsRef.current.find(({ id }) => id === connectionId);
    if (!connection) return failure({ blockers: [], code: "provider_connection_not_found", resourceIds: [] });
    return runCatalogResult(() => updateAdminProviderConnection(connectionId, {
      ...input,
      activate: true,
      unassignedPolicy: connection.unassignedPolicy
    }), "Connection settings saved.", { quiet: true, reconcileFailure: true, scope: connectionId });
  }, [runCatalogResult]);

  const actions = useMemo(() => ({
    addCatalogModels: async (connectionId: string, body: Parameters<typeof addAdminProviderCatalogModels>[1]) => {
      let unavailableModelIds: string[] = [];
      const result = await runCatalogResult(async () => {
        const response = await addAdminProviderCatalogModels(connectionId, body);
        if (!response.ok) return response;
        unavailableModelIds = response.data.unavailableModelIds;
        return { ok: true as const, data: response.data.connections };
      }, null, { quiet: true, reconcileFailure: true, scope: connectionId });
      return { ...result, unavailableModelIds };
    },
    /** `Stop checking`: the run ends where it is; results already stored stay. */
    cancelModelChecks: (connectionId: string, runId: string) =>
      runCatalog(
        () => runAdminProviderConnectionAction(connectionId, { action: "cancel_check", runId }),
        "Checking stopped.",
        true,
        connectionId
      ),
    connectionAction: async (
      connectionId: string,
      body: unknown,
      success: string,
      runOptions: Readonly<{ quiet?: boolean }> = {}
    ) => (await runCatalogResult(
      () => runAdminProviderConnectionAction(connectionId, body),
      success,
      { quiet: runOptions.quiet, scope: connectionId }
    )).ok,
    deleteConnection: (connectionId: string) =>
      runCatalogResult(
        () => deleteAdminProviderConnection(connectionId),
        "Provider deleted.",
        { quiet: true, scope: connectionId }
      ),
    deleteCredential: (connectionId: string, credentialId: string) =>
      runCatalogResult(
        () => deleteAdminProviderCredential(connectionId, credentialId),
        "Key deleted.",
        { quiet: true, scope: connectionId }
      ),
    deleteModel: (connectionId: string, modelId: string) =>
      runCatalogResult(
        () => deleteAdminProviderModel(connectionId, modelId),
        "Model removed.",
        { quiet: true, scope: connectionId }
      ),
    discoverEndpoints: (
      connectionId: string,
      credentialId: string,
      modelId: string
    ): Promise<AdminOpenRouterDiscoveredEndpoint[] | null> => runScopedDiscovery(
      () => discoverAdminOpenRouterEndpoints(connectionId, credentialId, modelId)
    ),
    discoverCompatibleModels: (
      connectionId: string,
      credentialId: string
    ): Promise<AdminCompatibleDiscoveredModel[] | null> => runScopedDiscovery(
      () => discoverAdminCompatibleModels(connectionId, credentialId)
    ),
    discoverModels: (
      connectionId: string,
      credentialId: string
    ): Promise<AdminOpenRouterDiscoveredModel[] | null> => runScopedDiscovery(
      () => discoverAdminOpenRouterModels(connectionId, credentialId)
    ),
    dismissError: () => {
      setError(null);
      setErrorCode(null);
      setErrorBlockers([]);
    },
    dismissNotice: () => setNotice(null),
    refresh,
    refreshQuietly,
    /** One-step rotation: the new key is tested and switched in before the response. */
    rotateCredential: (
      connectionId: string,
      credentialId: string,
      input: Readonly<{ expectedDraftVersion: number; secret: string }>
    ) => runCatalogResult(
      () => updateAdminProviderCredential(connectionId, credentialId, {
        action: "rotate",
        activate: true,
        expectedDraftVersion: input.expectedDraftVersion,
        secret: input.secret
      }),
      "Key rotated and working.",
      { quiet: true, scope: connectionId }
    ),
    saveConnectionSettings,
    renameModel: (connectionId: string, modelId: string, body: AdminProviderModelRename) => runModelSave(
      () => renameAdminProviderModel(connectionId, modelId, body),
      connectionId, modelId, body, "name"
    ),
    /**
     * Model `Test & Save` (PRD B2): create or update the model, take it live
     * and check it with the default key in one request. The sheet shows the
     * failure inline; a temporary check failure still saves the model.
     */
    saveModel: (
      connectionId: string,
      modelId: string | null,
      body: Readonly<{ configuration: unknown; displayName: string }> & Partial<AdminProviderModelEditGuard>,
      setupOptions?: Readonly<{ signal?: AbortSignal; onProgress?(value: AdminProviderSetupProgress): void }>
    ) => runModelSave(
      () => modelId === null
        ? createAdminProviderModel(connectionId, { ...body, activate: true }, fetch, setupOptions?.signal, setupOptions?.onProgress)
        : updateAdminProviderModel(connectionId, modelId, { ...body, action: "update", activate: true }, fetch, setupOptions?.signal, setupOptions?.onProgress),
      connectionId, modelId, body, "configuration"
    ),
    /** One-step add: the key is tested and becomes the default when none is set. */
    saveCredential: (
      connectionId: string,
      input: Readonly<{ label: string; secret: string }>
    ) => runCatalogResult(
      () => createAdminProviderCredential(connectionId, {
        activate: true,
        label: input.label,
        secret: input.secret
      }),
      "Key saved and working.",
      { quiet: true, scope: connectionId }
    ),
    /**
     * Background capability checks (PRD B3) for every enabled model or the
     * given ones with one key; progress arrives through the catalog. Silent:
     * the banner and the rows are the feedback.
     */
    startModelChecks: (
      connectionId: string,
      credentialId: string,
      modelIds?: readonly string[],
      retryUnresolved?: boolean
    ) => runCatalogResult(
      () => runAdminProviderConnectionAction(connectionId, {
        action: "check_models",
        credentialId,
        ...(retryUnresolved ? { retryUnresolved: true } : {}),
        ...(modelIds ? { modelIds: [...modelIds] } : {})
      }),
      null,
      { scope: connectionId }
    ),
    updateCredential: async (
      connectionId: string,
      credentialId: string,
      body: unknown,
      success: string,
      runOptions: Readonly<{ quiet?: boolean }> = {}
    ) => (await runCatalogResult(
      () => updateAdminProviderCredential(connectionId, credentialId, body),
      success,
      { quiet: runOptions.quiet, scope: connectionId }
    )).ok,
    updateModel: (connectionId: string, modelId: string, body: unknown, success: string) =>
      runCatalog(
        () => runAdminProviderModelAction(connectionId, modelId, body),
        success,
        false,
        connectionId
      )
  }), [refresh, refreshQuietly, runCatalog, runCatalogResult, runModelSave, runScopedDiscovery, saveConnectionSettings]);

  return {
    actions,
    state: {
      busy,
      connections,
      error,
      errorBlockers,
      errorCode,
      feedbackConnectionId,
      loaded,
      loading,
      notice
    }
  };
}

export type AdminProvidersController = ReturnType<typeof useAdminProvidersController>;
