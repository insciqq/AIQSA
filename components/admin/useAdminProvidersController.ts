"use client";

import {
  discoverAdminCompatibleModels,
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
  testAdminProviderDraft,
  updateAdminProviderConnection,
  updateAdminProviderCredential,
  updateAdminProviderModel,
  type AdminProviderClientError,
  type AdminProviderClientResult
} from "./adminProvidersApi";
import type {
  AdminCompatibleDiscoveredModel,
  AdminOpenRouterDiscoveredEndpoint,
  AdminOpenRouterDiscoveredModel,
  AdminProviderConnection,
  AdminProviderConnectionConfiguration
} from "@/lib/contracts/adminProviders";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type CatalogOperation = () => Promise<AdminProviderClientResult<AdminProviderConnection[]>>;

export type AdminProviderOperationResult =
  | { ok: true }
  | { error: AdminProviderClientError; message: string; ok: false };

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

function failure(error: AdminProviderClientError): AdminProviderOperationResult {
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
  const autoLoadAttemptedRef = useRef(false);
  const optionsRef = useRef(options);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

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
    if (generation !== catalogGenerationRef.current) return false;
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
    success: string,
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
    optionsRef.current.onNotice?.(success);
    notifyMutationCommitted(optionsRef.current.onMutationCommitted);
    return { ok: true };
  }, [applyConnections]);

  const runCatalogResult = useCallback(async (
    operation: CatalogOperation,
    success: string,
    runOptions: CatalogRunOptions = {}
  ): Promise<AdminProviderOperationResult> => {
    if (busyRef.current) {
      return failure({ blockers: [], code: "provider_admin_busy", resourceIds: [] });
    }
    const generation = ++catalogGenerationRef.current;
    beginRun();
    const result = await operation();
    if (generation !== catalogGenerationRef.current) {
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

  const runDiscovery = useCallback(async <T,>(
    operation: () => Promise<AdminProviderClientResult<T>>,
    feedbackScope: string
  ): Promise<T | null> => {
    if (busyRef.current) return null;
    beginRun();
    const result = await operation();
    busyRef.current = false;
    setBusy(false);
    if (!result.ok) {
      const message = adminProviderErrorMessage(result.error);
      setError(message);
      setErrorCode(result.error.code);
      setErrorBlockers(result.error.blockers);
      setFeedbackConnectionId(feedbackScope);
      return null;
    }
    return result.data;
  }, [beginRun]);

  const runScopedDiscovery = useCallback(async <T,>(
    operation: () => Promise<AdminProviderClientResult<T>>
  ): Promise<T | null> => {
    const result = await operation();
    return result.ok ? result.data : null;
  }, []);

  /**
   * Connection settings save as one visible action. A changed endpoint is
   * only ever validated with the key the administrator re-entered, so the
   * stored key is never sent to an endpoint it was not saved for. Any
   * failure restores the previous settings before reporting.
   */
  const saveConnectionSettings = useCallback(async (
    connectionId: string,
    input: Readonly<{
      configuration: AdminProviderConnectionConfiguration;
      displayName: string;
      /** Re-entered default key, required only when the endpoint changes. */
      secret: string | null;
    }>
  ): Promise<AdminProviderOperationResult> => {
    if (busyRef.current) {
      return failure({ blockers: [], code: "provider_admin_busy", resourceIds: [] });
    }
    const connection = connectionsRef.current.find(({ id }) => id === connectionId);
    if (!connection) {
      return failure({ blockers: [], code: "provider_connection_not_found", resourceIds: [] });
    }
    const generation = ++catalogGenerationRef.current;
    beginRun();
    const quiet = { quiet: true, scope: connectionId };
    const previous = {
      configuration: connection.draftConfig,
      displayName: connection.displayName,
      unassignedPolicy: connection.unassignedPolicy
    };
    const draft = await updateAdminProviderConnection(connectionId, {
      configuration: input.configuration,
      displayName: input.displayName,
      expectedDraftVersion: connection.draftVersion,
      unassignedPolicy: connection.unassignedPolicy
    });
    if (generation !== catalogGenerationRef.current) {
      busyRef.current = false;
      setBusy(false);
      return failure({ blockers: [], code: "provider_admin_superseded", resourceIds: [] });
    }
    if (!draft.ok) return finishFailure(draft.error, quiet);
    if (!connection.activeConfig) {
      // Nothing is live yet: the saved settings are what the first key check will use.
      return finishSuccess(draft.data, "Connection settings saved.", { scope: connectionId });
    }

    const revertDraft = () => updateAdminProviderConnection(connectionId, {
      ...previous,
      expectedDraftVersion: connection.draftVersion + 1
    });
    const defaultCredential = connection.credentials.find(({ id }) => id === connection.defaultCredentialId);
    let rotatedDraft: { credentialId: string; draftVersion: number } | null = null;
    if (input.secret !== null && defaultCredential) {
      const rotated = await updateAdminProviderCredential(connectionId, defaultCredential.id, {
        action: "rotate",
        expectedDraftVersion: defaultCredential.draftVersion,
        secret: input.secret
      });
      if (!rotated.ok) {
        await revertDraft();
        return finishFailure(rotated.error, quiet);
      }
      rotatedDraft = { credentialId: defaultCredential.id, draftVersion: defaultCredential.draftVersion + 1 };
    }
    const activated = await runAdminProviderConnectionAction(connectionId, {
      action: "activate",
      confirmUnavailable: true,
      enableConnection: connection.enabled
    });
    if (!activated.ok) {
      if (rotatedDraft) {
        await updateAdminProviderCredential(connectionId, rotatedDraft.credentialId, {
          action: "clear_draft",
          confirmed: true,
          expectedDraftVersion: rotatedDraft.draftVersion
        });
      }
      await revertDraft();
      const latest = await getAdminProviderConnections();
      if (latest.ok) applyConnections(latest.data);
      return finishFailure(activated.error, quiet);
    }
    return finishSuccess(activated.data, "Connection settings saved.", { scope: connectionId });
  }, [applyConnections, beginRun, finishFailure, finishSuccess]);

  const actions = useMemo(() => ({
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
    createModel: (connectionId: string, body: unknown) =>
      runCatalog(
        () => createAdminProviderModel(connectionId, body),
        "Model saved.",
        false,
        connectionId
      ),
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
      runCatalog(
        () => deleteAdminProviderModel(connectionId, modelId),
        "Model removed.",
        false,
        connectionId
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
    refreshActive: (
      connectionId: string,
      providerModelId: string,
      credentialId: string,
      confirmPaidRequest: boolean
    ) => runCatalog(
      () => runAdminProviderConnectionAction(connectionId, {
        action: "refresh_active",
        confirmPaidRequest,
        credentialId,
        providerModelId
      }),
      "Check finished.",
      true,
      connectionId
    ),
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
    testDraft: async (connectionId: string, modelId: string, body: unknown) => {
      const check = await runDiscovery(
        () => testAdminProviderDraft(connectionId, modelId, body),
        connectionId
      );
      if (!check) return false;
      await refresh();
      setFeedbackConnectionId(connectionId);
      setNotice(check.status === "available"
        ? "The model is available with this key."
        : "The provider reported this model or route as unavailable.");
      return true;
    },
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
        () => updateAdminProviderModel(connectionId, modelId, body),
        success,
        false,
        connectionId
      )
  }), [refresh, runCatalog, runCatalogResult, runDiscovery, runScopedDiscovery, saveConnectionSettings]);

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
