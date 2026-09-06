"use client";

import {
  activateAdminMcpDraft,
  adminMcpErrorMessage,
  checkAdminMcpUpdate,
  createAdminMcpServer,
  deleteAdminMcpServer,
  disconnectAdminMcpValidationOAuth,
  rebuildAdminMcpRevision,
  requestAdminMcpCatalog,
  rollbackAdminMcpServer,
  setAdminMcpGrant,
  testAdminMcpDraft,
  updateAdminMcpServer,
  type AdminMcpClientResult
} from "@/components/admin/adminMcpApi";
import { isAdminMcpActivationPending } from "@/components/admin/adminMcpActivation";
import type {
  AdminMcpCreateRequest,
  AdminMcpDraftTestRequest,
  AdminMcpGrantRequest,
  AdminMcpRollbackRequest,
  AdminMcpServer,
  AdminMcpUpdateRequest,
  McpSlotValue
} from "@/lib/contracts/mcp";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminMcpController = Readonly<{
  actions: Readonly<{
    activate(serverId: string): Promise<boolean>;
    checkUpdate(serverId: string, body: AdminMcpDraftTestRequest): Promise<boolean>;
    create(body: AdminMcpCreateRequest): Promise<AdminMcpServer | null>;
    delete(serverId: string): Promise<boolean>;
    disconnectValidationOAuth(serverId: string): Promise<boolean>;
    dismissError(): void;
    dismissNotice(): void;
    grant(serverId: string, body: AdminMcpGrantRequest): Promise<boolean>;
    rebuild(serverId: string, body: {
      oneTimeValues?: Record<string, McpSlotValue>;
      replaceDraft?: boolean;
      revisionId: string;
    }): Promise<boolean>;
    refresh(): Promise<void>;
    rollback(serverId: string, body: AdminMcpRollbackRequest): Promise<boolean>;
    select(serverId: string): void;
    save(serverId: string, body: AdminMcpUpdateRequest & AdminMcpDraftTestRequest): Promise<{ applied: boolean; updatedAt?: string }>;
    test(serverId: string, body: AdminMcpDraftTestRequest): Promise<boolean>;
    update(serverId: string, body: AdminMcpUpdateRequest): Promise<boolean>;
  }>;
  state: Readonly<{
    busy: boolean;
    error: string | null;
    loaded: boolean;
    loading: boolean;
    notice: string | null;
    selectedServer: AdminMcpServer | null;
    servers: readonly AdminMcpServer[];
  }>;
}>;

export type UseAdminMcpControllerOptions = Readonly<{
  active: boolean;
  fetcher?: Fetcher;
  onMutationCommitted?(): void | Promise<unknown>;
}>;

function notifyMutationCommitted(callback: UseAdminMcpControllerOptions["onMutationCommitted"]): void {
  if (!callback) return;
  void Promise.resolve().then(callback).catch(() => undefined);
}

function sortServers(servers: readonly AdminMcpServer[]): AdminMcpServer[] {
  return [...servers].sort((left, right) => {
    if (Boolean(left.archivedAt) !== Boolean(right.archivedAt)) return left.archivedAt ? 1 : -1;
    return left.name.localeCompare(right.name);
  });
}

export function useAdminMcpController({
  active,
  fetcher = fetch,
  onMutationCommitted
}: UseAdminMcpControllerOptions): AdminMcpController {
  const [servers, setServers] = useState<AdminMcpServer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const loadRef = useRef<Promise<void> | null>(null);
  const busyRef = useRef(false);
  const mutationEpochRef = useRef(0);
  const autoLoadAttemptedRef = useRef(false);

  const replaceServer = useCallback((server: AdminMcpServer) => {
    setServers((current) => sortServers([
      ...current.filter((candidate) => candidate.id !== server.id),
      server
    ]));
  }, []);

  const loadCatalog = useCallback(async (silent: boolean) => {
    if (busyRef.current) return;
    if (loadRef.current) return loadRef.current;
    const epoch = mutationEpochRef.current;
    const operation = (async () => {
      if (!silent) setLoading(true);
      try {
        const result = await requestAdminMcpCatalog(fetcher);
        if (epoch !== mutationEpochRef.current) return;
        if (result.ok) {
          setServers(sortServers(result.data.servers));
          setLoaded(true);
          if (!silent) setError(null);
        } else if (!silent) {
          setError(adminMcpErrorMessage(result.error));
        }
      } finally {
        if (!silent) setLoading(false);
      }
    })();
    loadRef.current = operation;
    try {
      await operation;
    } finally {
      if (loadRef.current === operation) loadRef.current = null;
    }
  }, [fetcher]);

  const refresh = useCallback(() => loadCatalog(false), [loadCatalog]);

  useEffect(() => {
    if (!active) {
      autoLoadAttemptedRef.current = false;
      return;
    }
    if (!loading && !autoLoadAttemptedRef.current) {
      autoLoadAttemptedRef.current = true;
      void loadCatalog(loaded);
    }
  }, [active, loaded, loading, loadCatalog]);

  const activationPending = servers.some((server) =>
    isAdminMcpActivationPending(server.activation)
  );

  useEffect(() => {
    if (!active || !loaded) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const interval = activationPending ? 1_200 : 30_000;
    const poll = async () => {
      if (cancelled) return;
      if (!busyRef.current && (typeof document === "undefined" || document.visibilityState !== "hidden")) {
        await loadCatalog(true);
      }
      if (!cancelled) timer = setTimeout(() => void poll(), interval);
    };

    timer = setTimeout(() => void poll(), interval);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, activationPending, loadCatalog, loaded]);

  const runServerMutation = useCallback(async (
    operation: () => Promise<AdminMcpClientResult<AdminMcpServer>>,
    success: string | ((server: AdminMcpServer) => string)
  ): Promise<AdminMcpServer | null> => {
    if (busyRef.current) return null;
    busyRef.current = true;
    mutationEpochRef.current += 1;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await operation();
    busyRef.current = false;
    setBusy(false);
    if (!result.ok) {
      setError(adminMcpErrorMessage(result.error));
      return null;
    }
    replaceServer(result.data);
    setNotice(typeof success === "function" ? success(result.data) : success);
    notifyMutationCommitted(onMutationCommitted);
    return result.data;
  }, [onMutationCommitted, replaceServer]);

  const create = useCallback(async (body: AdminMcpCreateRequest) => {
    if (busyRef.current) return null;
    busyRef.current = true;
    mutationEpochRef.current += 1;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await createAdminMcpServer(body, fetcher);
      if (!created.ok) {
        setError(adminMcpErrorMessage(created.error));
        return null;
      }
      replaceServer(created.data);
      setSelectedId(created.data.id);
      notifyMutationCommitted(onMutationCommitted);

      if (body.draft.auth.mode === "oauth") {
        setNotice("MCP settings prepared. Connect OAuth to check and apply them automatically.");
        return created.data;
      }

      setNotice(body.activate
        ? "MCP activation started. Setup continues in the background."
        : "MCP settings prepared. Use Test & Save to apply them.");
      return created.data;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [fetcher, onMutationCommitted, replaceServer]);

  const booleanMutation = useCallback(async (
    operation: () => Promise<AdminMcpClientResult<AdminMcpServer>>,
    success: string | ((server: AdminMcpServer) => string)
  ) => Boolean(await runServerMutation(operation, success)), [runServerMutation]);

  const update = useCallback((serverId: string, body: AdminMcpUpdateRequest) =>
    booleanMutation(() => updateAdminMcpServer(serverId, body.draft ? {
      ...body, expectedUpdatedAt: body.expectedUpdatedAt ?? servers.find((server) => server.id === serverId)?.updatedAt
    } : body, fetcher), body.draft
      ? "Use Test & Save to apply your changes."
      : "MCP settings updated."),
  [booleanMutation, fetcher, servers]);
  const save = useCallback(async (serverId: string, body: AdminMcpUpdateRequest & AdminMcpDraftTestRequest) => {
    if (busyRef.current) return { applied: false };
    const current = servers.find((server) => server.id === serverId);
    if (!current) return { applied: false };
    busyRef.current = true;
    mutationEpochRef.current += 1;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { oneTimeValues, sharedValues, publish: _publish, ...patch } = body;
      let candidate = current;
      if (patch.draft !== undefined || patch.name !== undefined || patch.description !== undefined) {
        const staged = await updateAdminMcpServer(serverId, {
          ...patch,
          expectedUpdatedAt: patch.expectedUpdatedAt ?? current.updatedAt
        }, fetcher);
        if (!staged.ok) {
          setError(adminMcpErrorMessage(staged.error));
          return { applied: false };
        }
        candidate = staged.data;
        replaceServer(candidate);
      }
      const saved = await testAdminMcpDraft(serverId, {
        expectedUpdatedAt: candidate.updatedAt,
        oneTimeValues,
        publish: true,
        ...(sharedValues ? { sharedValues } : {})
      }, fetcher);
      if (!saved.ok) {
        setError(adminMcpErrorMessage(saved.error));
        return { applied: false, updatedAt: candidate.updatedAt };
      }
      replaceServer(saved.data);
      setNotice("MCP settings checked and applied.");
      notifyMutationCommitted(onMutationCommitted);
      return { applied: true, updatedAt: saved.data.updatedAt };
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [fetcher, onMutationCommitted, replaceServer, servers]);
  const deleteServer = useCallback(async (serverId: string) => {
    const deleted = await runServerMutation(
      () => deleteAdminMcpServer(serverId, fetcher),
      "MCP server deleted."
    );
    if (!deleted) return false;
    setServers((current) => current.filter((server) => server.id !== serverId));
    setSelectedId((current) => current === serverId ? null : current);
    return true;
  }, [fetcher, runServerMutation]);
  const test = useCallback((serverId: string, body: AdminMcpDraftTestRequest) =>
    booleanMutation(() => testAdminMcpDraft(serverId, body, fetcher), "Draft tested and tool inventory refreshed."),
  [booleanMutation, fetcher]);
  const checkUpdate = useCallback((serverId: string, body: AdminMcpDraftTestRequest) =>
    booleanMutation(() => checkAdminMcpUpdate(serverId, body, fetcher), "Update check completed. Review the tested draft."),
  [booleanMutation, fetcher]);
  const activate = useCallback((serverId: string) =>
    booleanMutation(
      () => activateAdminMcpDraft(serverId, fetcher),
      (server) => isAdminMcpActivationPending(server.activation)
        ? "MCP activation started. Setup continues in the background."
        : "Tested MCP revision activated."
    ),
  [booleanMutation, fetcher]);
  const rollback = useCallback((serverId: string, body: AdminMcpRollbackRequest) =>
    booleanMutation(() => rollbackAdminMcpServer(serverId, body, fetcher), "MCP server rolled back."),
  [booleanMutation, fetcher]);
  const rebuild = useCallback((serverId: string, body: {
    oneTimeValues?: Record<string, McpSlotValue>;
    replaceDraft?: boolean;
    revisionId: string;
  }) => booleanMutation(
    () => rebuildAdminMcpRevision(serverId, body, fetcher),
    "Revision rebuilt and the newly materialized MCP revision activated."
  ), [booleanMutation, fetcher]);
  const grant = useCallback((serverId: string, body: AdminMcpGrantRequest) =>
    booleanMutation(() => setAdminMcpGrant(serverId, body, fetcher), "MCP access updated."),
  [booleanMutation, fetcher]);

  const disconnectValidationOAuth = useCallback(async (serverId: string) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    mutationEpochRef.current += 1;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await disconnectAdminMcpValidationOAuth(serverId, fetcher);
      if (!result.ok) {
        setError(adminMcpErrorMessage(result.error));
        return false;
      }

      const catalog = await requestAdminMcpCatalog(fetcher);
      if (catalog.ok) {
        setServers(sortServers(catalog.data.servers));
      } else {
        setError(adminMcpErrorMessage(catalog.error));
      }
      setNotice("Validation OAuth connection disconnected.");
      notifyMutationCommitted(onMutationCommitted);
      return true;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [fetcher, onMutationCommitted]);

  const selectedServer = useMemo(() => {
    return selectedId
      ? servers.find((server) => server.id === selectedId) ?? null
      : null;
  }, [selectedId, servers]);

  return {
    actions: {
      activate,
      checkUpdate,
      create,
      delete: deleteServer,
      disconnectValidationOAuth,
      dismissError: () => setError(null),
      dismissNotice: () => setNotice(null),
      grant,
      rebuild,
      refresh,
      rollback,
      save,
      select: setSelectedId,
      test,
      update
    },
    state: {
      busy,
      error,
      loaded,
      loading,
      notice,
      selectedServer,
      servers
    }
  };
}
