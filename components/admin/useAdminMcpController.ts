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
import { isAdminMcpActivationPending } from "@/components/admin/mcp/adminMcpActivation";
import type { AdminGroup } from "@/lib/contracts/admin";
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

export type AdminMcpCreateResult =
  | Readonly<{ ok: true; server: AdminMcpServer }>
  | Readonly<{ message: string; ok: false }>;

export type AdminMcpSaveResult = Readonly<{
  applied: boolean;
  /** The reason a check failed, for the form that keeps its fields. */
  message?: string;
  updatedAt?: string;
}>;

export type AdminMcpController = Readonly<{
  actions: Readonly<{
    activate(serverId: string): Promise<boolean>;
    checkUpdate(serverId: string, body: AdminMcpDraftTestRequest): Promise<boolean>;
    /** Creates the server; the failure message goes back to the form, not to a toast. */
    create(body: AdminMcpCreateRequest): Promise<AdminMcpCreateResult>;
    /** Deletes after the shared confirmation; the caller navigates away. */
    delete(serverId: string): Promise<boolean>;
    disconnectValidationOAuth(serverId: string): Promise<boolean>;
    grant(serverId: string, body: AdminMcpGrantRequest): Promise<boolean>;
    /** One request at a time across the current catalog; stops at the first failed grant. */
    bulkGrantGroup(group: Pick<AdminGroup, "archivedAt" | "id" | "name" | "systemRole">, canUse: boolean): Promise<boolean>;
    rebuild(serverId: string, body: {
      oneTimeValues?: Record<string, McpSlotValue>;
      replaceDraft?: boolean;
      revisionId: string;
    }): Promise<boolean>;
    refresh(): Promise<void>;
    rollback(serverId: string, body: AdminMcpRollbackRequest): Promise<boolean>;
    /**
     * Test & Save: stages the changes, checks them and applies them as one
     * client flow. A failed check keeps the previous configuration running and
     * returns the message for the caller to show.
     */
    save(serverId: string, body: AdminMcpUpdateRequest & AdminMcpDraftTestRequest): Promise<AdminMcpSaveResult>;
    update(serverId: string, body: AdminMcpUpdateRequest): Promise<boolean>;
  }>;
  state: Readonly<{
    busy: boolean;
    bulkGrantProgress?: Readonly<{ completed: number; groupId: string; total: number }> | null;
    /** Why the catalog could not be loaded, for the list; action outcomes go to the feedback host. */
    error: string | null;
    loaded: boolean;
    loading: boolean;
    servers: readonly AdminMcpServer[];
  }>;
}>;

export type UseAdminMcpControllerOptions = Readonly<{
  active: boolean;
  fetcher?: Fetcher;
  onError?(message: string): void;
  onMutationCommitted?(): void | Promise<unknown>;
  onNotice?(message: string): void;
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

/**
 * The one state owner of the MCP servers section, shared with the Users and
 * Groups pages for their access panels: the catalog the server returned last,
 * one busy flag, background polling while a setup runs, and mutations that
 * always replace a server with the server's answer.
 */
export function useAdminMcpController({
  active,
  fetcher = fetch,
  onError,
  onMutationCommitted,
  onNotice
}: UseAdminMcpControllerOptions): AdminMcpController {
  const [servers, setServers] = useState<AdminMcpServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bulkGrantProgress, setBulkGrantProgress] = useState<AdminMcpController["state"]["bulkGrantProgress"]>(null);
  const [error, setError] = useState<string | null>(null);
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
        setLoaded(true);
        if (result.ok) {
          setServers(sortServers(result.data.servers));
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
    notice: string | null | ((server: AdminMcpServer) => string | null)
  ): Promise<AdminMcpServer | null> => {
    if (busyRef.current) return null;
    busyRef.current = true;
    mutationEpochRef.current += 1;
    setBusy(true);
    const result = await operation();
    busyRef.current = false;
    setBusy(false);
    if (!result.ok) {
      onError?.(adminMcpErrorMessage(result.error));
      return null;
    }
    replaceServer(result.data);
    const message = typeof notice === "function" ? notice(result.data) : notice;
    if (message) onNotice?.(message);
    notifyMutationCommitted(onMutationCommitted);
    return result.data;
  }, [onError, onMutationCommitted, onNotice, replaceServer]);

  const booleanMutation = useCallback(async (
    operation: () => Promise<AdminMcpClientResult<AdminMcpServer>>,
    notice: string | null | ((server: AdminMcpServer) => string | null)
  ) => Boolean(await runServerMutation(operation, notice)), [runServerMutation]);

  const create = useCallback(async (body: AdminMcpCreateRequest): Promise<AdminMcpCreateResult> => {
    if (busyRef.current) return { message: "Another MCP action is still running.", ok: false };
    busyRef.current = true;
    mutationEpochRef.current += 1;
    setBusy(true);
    try {
      const created = await createAdminMcpServer(body, fetcher);
      if (!created.ok) return { message: adminMcpErrorMessage(created.error), ok: false };
      replaceServer(created.data);
      notifyMutationCommitted(onMutationCommitted);
      onNotice?.(body.draft.auth.mode === "oauth"
        ? "Settings saved. Connect your account to check and apply them."
        : body.activate
          ? "Settings saved. Setup continues in the background."
          : "Settings saved. Use Test & Save to apply them.");
      return { ok: true, server: created.data };
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [fetcher, onMutationCommitted, onNotice, replaceServer]);

  const update = useCallback((serverId: string, body: AdminMcpUpdateRequest) =>
    booleanMutation(() => updateAdminMcpServer(serverId, body.draft ? {
      ...body, expectedUpdatedAt: body.expectedUpdatedAt ?? servers.find((server) => server.id === serverId)?.updatedAt
    } : body, fetcher), typeof body.enabled === "boolean"
      ? body.enabled ? "MCP server enabled." : "MCP server disabled."
      : body.tool ? `Tool ${body.tool.enabled ? "enabled" : "disabled"}.`
      : body.toolAccess ? "Tool access updated."
      : body.draft ? null : "MCP settings updated."),
  [booleanMutation, fetcher, servers]);

  const save = useCallback(async (
    serverId: string,
    body: AdminMcpUpdateRequest & AdminMcpDraftTestRequest
  ): Promise<AdminMcpSaveResult> => {
    if (busyRef.current) return { applied: false, message: "Another MCP action is still running." };
    const current = servers.find((server) => server.id === serverId);
    if (!current) return { applied: false, message: "This MCP server no longer exists." };
    busyRef.current = true;
    mutationEpochRef.current += 1;
    setBusy(true);
    try {
      const saved = await testAdminMcpDraft(serverId, {
        ...body,
        expectedUpdatedAt: body.expectedUpdatedAt ?? current.updatedAt,
        publish: true
      }, fetcher);
      if (!saved.ok) {
        return { applied: false, message: adminMcpErrorMessage(saved.error) };
      }
      replaceServer(saved.data);
      onNotice?.(isAdminMcpActivationPending(saved.data.activation)
        ? "Settings checked. Setup continues in the background."
        : "Settings checked and applied.");
      notifyMutationCommitted(onMutationCommitted);
      return { applied: true, updatedAt: saved.data.updatedAt };
    } finally {
      mutationEpochRef.current += 1;
      busyRef.current = false;
      setBusy(false);
    }
  }, [fetcher, onMutationCommitted, onNotice, replaceServer, servers]);

  const deleteServer = useCallback(async (serverId: string) => {
    const deleted = await runServerMutation(
      () => deleteAdminMcpServer(serverId, fetcher),
      "MCP server deleted."
    );
    if (!deleted) return false;
    setServers((current) => current.filter((server) => server.id !== serverId));
    return true;
  }, [fetcher, runServerMutation]);
  const checkUpdate = useCallback((serverId: string, body: AdminMcpDraftTestRequest) =>
    booleanMutation(
      () => checkAdminMcpUpdate(serverId, body, fetcher),
      (server) => isAdminMcpActivationPending(server.activation)
        ? "Update check started. It continues in the background."
        : "Update check finished. Review the tools, then use Test & Save to apply."
    ),
  [booleanMutation, fetcher]);
  const activate = useCallback((serverId: string) =>
    booleanMutation(
      () => activateAdminMcpDraft(serverId, fetcher),
      (server) => isAdminMcpActivationPending(server.activation)
        ? "Setup restarted. It continues in the background."
        : "Settings applied."
    ),
  [booleanMutation, fetcher]);
  const rollback = useCallback((serverId: string, body: AdminMcpRollbackRequest) =>
    booleanMutation(() => rollbackAdminMcpServer(serverId, body, fetcher), "Earlier configuration restored."),
  [booleanMutation, fetcher]);
  const rebuild = useCallback((serverId: string, body: {
    oneTimeValues?: Record<string, McpSlotValue>;
    replaceDraft?: boolean;
    revisionId: string;
  }) => booleanMutation(
    () => rebuildAdminMcpRevision(serverId, body, fetcher),
    (server) => isAdminMcpActivationPending(server.activation)
      ? "Rebuild started. It continues in the background."
      : "Configuration rebuilt and applied."
  ), [booleanMutation, fetcher]);
  const grant = useCallback((serverId: string, body: AdminMcpGrantRequest) =>
    booleanMutation(() => setAdminMcpGrant(serverId, body, fetcher), "MCP access updated."),
  [booleanMutation, fetcher]);

  const bulkGrantGroup = useCallback<AdminMcpController["actions"]["bulkGrantGroup"]>(async (group, canUse) => {
    if (busyRef.current || loading || !loaded || error || group.archivedAt || group.systemRole === "full_access") return false;
    const eligible = [...new Map(servers.filter((server) => !server.archivedAt).map((server) => [server.id, server])).values()];
    const pending = eligible.filter((server) =>
      server.grants.some((grant) => grant.groupId === group.id && grant.canUse) !== canUse
    );
    if (!pending.length) return false;
    busyRef.current = true;
    mutationEpochRef.current += 1;
    setBusy(true);
    let completed = 0;
    let failure: string | null = null;
    setBulkGrantProgress({ completed, groupId: group.id, total: pending.length });
    try {
      for (const server of pending) {
        const result = await setAdminMcpGrant(server.id, { canUse, groupId: group.id }, fetcher);
        if (!result.ok) {
          failure = adminMcpErrorMessage(result.error);
          break;
        }
        replaceServer(result.data);
        completed += 1;
        setBulkGrantProgress({ completed, groupId: group.id, total: pending.length });
      }
      const catalog = await requestAdminMcpCatalog(fetcher);
      if (catalog.ok) {
        setServers(sortServers(catalog.data.servers));
        setError(null);
      } else {
        setError(adminMcpErrorMessage(catalog.error));
      }
      // Keep summary feedback after the dashboard's refresh, which clears earlier errors.
      if (onMutationCommitted) await Promise.resolve().then(onMutationCommitted).catch(() => undefined);
      if (failure) {
        onError?.(`${group.name}: ${completed} of ${pending.length} MCP access changes confirmed before the operation stopped. ${failure} ${catalog.ok
          ? "Review the saved grants before retrying."
          : "Current MCP grants could not be reloaded. Refresh before retrying."}`);
        return false;
      }
      if (!catalog.ok) {
        onError?.(`${group.name}: ${completed} of ${pending.length} MCP access changes saved, but current grants could not be reloaded. Refresh to review them.`);
        return false;
      }
      onNotice?.(`${group.name}: ${canUse ? "All current MCP servers granted." : "Current MCP server access cleared."}`);
      return true;
    } finally {
      mutationEpochRef.current += 1;
      busyRef.current = false;
      setBusy(false);
      setBulkGrantProgress(null);
    }
  }, [error, fetcher, loaded, loading, onError, onMutationCommitted, onNotice, replaceServer, servers]);

  const disconnectValidationOAuth = useCallback(async (serverId: string) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    mutationEpochRef.current += 1;
    setBusy(true);
    try {
      const result = await disconnectAdminMcpValidationOAuth(serverId, fetcher);
      if (!result.ok) {
        onError?.(adminMcpErrorMessage(result.error));
        return false;
      }

      const catalog = await requestAdminMcpCatalog(fetcher);
      if (catalog.ok) {
        setServers(sortServers(catalog.data.servers));
      } else {
        onError?.(adminMcpErrorMessage(catalog.error));
      }
      onNotice?.("Your authorization was disconnected.");
      notifyMutationCommitted(onMutationCommitted);
      return true;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [fetcher, onError, onMutationCommitted, onNotice]);

  const actions = useMemo<AdminMcpController["actions"]>(() => ({
    activate,
    bulkGrantGroup,
    checkUpdate,
    create,
    delete: deleteServer,
    disconnectValidationOAuth,
    grant,
    rebuild,
    refresh,
    rollback,
    save,
    update
  }), [activate, bulkGrantGroup, checkUpdate, create, deleteServer, disconnectValidationOAuth, grant, rebuild, refresh, rollback, save, update]);

  return useMemo(() => ({
    actions,
    state: { bulkGrantProgress, busy, error, loaded, loading, servers }
  }), [actions, bulkGrantProgress, busy, error, loaded, loading, servers]);
}
