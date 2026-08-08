"use client";

import {
  discoverAdminCompatibleModels,
  adminProviderErrorMessage,
  createAdminProviderConnection,
  createAdminProviderCredential,
  createAdminProviderModel,
  deleteAdminProviderConnection,
  deleteAdminProviderCredential,
  deleteAdminProviderModel,
  discoverAdminOpenRouterEndpoints,
  discoverAdminOpenRouterModels,
  getAdminProviderConnections,
  runAdminProviderConnectionAction,
  testAdminProviderCredential,
  testAdminProviderDraft,
  updateAdminProviderConnection,
  updateAdminProviderCredential,
  updateAdminProviderModel,
  type AdminProviderClientResult
} from "./adminProvidersApi";
import type {
  AdminCompatibleDiscoveredModel,
  AdminOpenRouterDiscoveredEndpoint,
  AdminOpenRouterDiscoveredModel,
  AdminProviderConnection
} from "@/lib/contracts/adminProviders";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type CatalogOperation = () => Promise<AdminProviderClientResult<AdminProviderConnection[]>>;

export type UseAdminProvidersControllerOptions = Readonly<{
  onMutationCommitted?(): void | Promise<unknown>;
}>;

function notifyMutationCommitted(callback: UseAdminProvidersControllerOptions["onMutationCommitted"]): void {
  if (!callback) return;
  void Promise.resolve().then(callback).catch(() => undefined);
}

export function useAdminProvidersController(
  active: boolean,
  options: UseAdminProvidersControllerOptions = {}
) {
  const [connections, setConnections] = useState<AdminProviderConnection[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  const catalogGenerationRef = useRef(0);
  const autoLoadAttemptedRef = useRef(false);

  const applyConnections = useCallback((next: AdminProviderConnection[]) => {
    setConnections(next);
    setSelectedId((current) => current && next.some(({ id }) => id === current)
      ? current
      : next[0]?.id ?? null);
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

  const runCatalog = useCallback(async (
    operation: CatalogOperation,
    success: string,
    reconcileFailure = false,
    feedbackScope: string | null = null
  ) => {
    if (busyRef.current) return false;
    const generation = ++catalogGenerationRef.current;
    busyRef.current = true;
    setLoading(false);
    setBusy(true);
    setError(null);
    setErrorCode(null);
    setErrorBlockers([]);
    setFeedbackConnectionId(null);
    setNotice(null);
    const result = await operation();
    if (generation !== catalogGenerationRef.current) {
      busyRef.current = false;
      setBusy(false);
      return false;
    }
    if (!result.ok) {
      const message = adminProviderErrorMessage(result.error);
      if (reconcileFailure) {
        const latest = await getAdminProviderConnections();
        if (latest.ok) applyConnections(latest.data);
      }
      busyRef.current = false;
      setBusy(false);
      setError(message);
      setErrorCode(result.error.code);
      setErrorBlockers(result.error.blockers);
      setFeedbackConnectionId(feedbackScope);
      return false;
    }
    busyRef.current = false;
    setBusy(false);
    applyConnections(result.data);
    setErrorCode(null);
    setErrorBlockers([]);
    setFeedbackConnectionId(
      feedbackScope && result.data.some(({ id }) => id === feedbackScope)
        ? feedbackScope
        : null
    );
    setNotice(success);
    notifyMutationCommitted(options.onMutationCommitted);
    return true;
  }, [applyConnections, options.onMutationCommitted]);

  const runDiscovery = useCallback(async <T,>(
    operation: () => Promise<AdminProviderClientResult<T>>,
    feedbackScope: string
  ): Promise<T | null> => {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setErrorCode(null);
    setErrorBlockers([]);
    setFeedbackConnectionId(null);
    setNotice(null);
    const result = await operation();
    busyRef.current = false;
    setBusy(false);
    if (!result.ok) {
      setError(adminProviderErrorMessage(result.error));
      setErrorCode(result.error.code);
      setErrorBlockers(result.error.blockers);
      setFeedbackConnectionId(feedbackScope);
      return null;
    }
    return result.data;
  }, []);

  const runScopedDiscovery = useCallback(async <T,>(
    operation: () => Promise<AdminProviderClientResult<T>>
  ): Promise<T | null> => {
    const result = await operation();
    return result.ok ? result.data : null;
  }, []);

  const selectedConnection = useMemo(
    () => connections.find(({ id }) => id === selectedId) ?? connections[0] ?? null,
    [connections, selectedId]
  );

  const select = useCallback((connectionId: string) => {
    setSelectedId(connectionId);
    setError(null);
    setErrorCode(null);
    setErrorBlockers([]);
    setFeedbackConnectionId(null);
    setNotice(null);
  }, []);

  return {
    actions: {
      connectionAction: (connectionId: string, body: unknown, success: string) =>
        runCatalog(
          () => runAdminProviderConnectionAction(connectionId, body),
          success,
          false,
          connectionId
        ),
      createConnection: (body: unknown) =>
        runCatalog(() => createAdminProviderConnection(body), "Provider connection draft created."),
      createCredential: (connectionId: string, body: unknown) =>
        runCatalog(
          () => createAdminProviderCredential(connectionId, body),
          "Credential draft saved.",
          false,
          connectionId
        ),
      createModel: (connectionId: string, body: unknown) =>
        runCatalog(
          () => createAdminProviderModel(connectionId, body),
          "Model deployment draft saved.",
          false,
          connectionId
        ),
      deleteConnection: (connectionId: string) =>
        runCatalog(
          () => deleteAdminProviderConnection(connectionId),
          "Provider connection deleted. Any child personal, chat, and installation defaults were cleared.",
          false,
          connectionId
        ),
      deleteCredential: (connectionId: string, credentialId: string) =>
        runCatalog(
          () => deleteAdminProviderCredential(connectionId, credentialId),
          "Credential deleted.",
          false,
          connectionId
        ),
      deleteModel: (connectionId: string, modelId: string) =>
        runCatalog(
          () => deleteAdminProviderModel(connectionId, modelId),
          "Model deployment deleted.",
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
        "Active availability evidence refreshed.",
        true,
        connectionId
      ),
      select,
      testCredential: async (connectionId: string, body: unknown) => {
        const result = await runDiscovery(
          () => testAdminProviderCredential(connectionId, body),
          connectionId
        );
        if (!result) return false;
        setFeedbackConnectionId(connectionId);
        setNotice(`Key accepted. The account catalog exposes ${result.modelCount} model${result.modelCount === 1 ? "" : "s"}.`);
        return true;
      },
      testDraft: async (connectionId: string, modelId: string, body: unknown) => {
        const check = await runDiscovery(
          () => testAdminProviderDraft(connectionId, modelId, body),
          connectionId
        );
        if (!check) return false;
        await refresh();
        setFeedbackConnectionId(connectionId);
        setNotice(check.status === "available"
          ? "The exact model and credential draft is available."
          : "The provider reported this exact model or route as unavailable.");
        return true;
      },
      updateConnection: (connectionId: string, body: unknown) =>
        runCatalog(
          () => updateAdminProviderConnection(connectionId, body),
          "Connection draft saved.",
          false,
          connectionId
        ),
      updateCredential: (connectionId: string, credentialId: string, body: unknown, success: string) =>
        runCatalog(
          () => updateAdminProviderCredential(connectionId, credentialId, body),
          success,
          false,
          connectionId
        ),
      updateModel: (connectionId: string, modelId: string, body: unknown, success: string) =>
        runCatalog(
          () => updateAdminProviderModel(connectionId, modelId, body),
          success,
          false,
          connectionId
        )
    },
    state: {
      busy,
      connections,
      error,
      errorBlockers,
      errorCode,
      feedbackConnectionId,
      loaded,
      loading,
      notice,
      selectedConnection
    }
  };
}

export type AdminProvidersController = ReturnType<typeof useAdminProvidersController>;
