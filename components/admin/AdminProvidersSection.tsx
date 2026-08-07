"use client";

import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { AdminProviderAuthenticationTask } from "@/components/admin/AdminProviderAuthenticationTask";
import { AdminProviderConnectionEditor } from "@/components/admin/AdminProviderConnectionEditor";
import { AdminProviderCredentialsTask } from "@/components/admin/AdminProviderCredentialsTask";
import { AdminProviderDiagnosticsTask } from "@/components/admin/AdminProviderDiagnosticsTask";
import { AdminProviderModelsTask } from "@/components/admin/AdminProviderModelsTask";
import {
  AdminAvailabilityStatus,
  adminAvailabilityRowClass,
  AdminTaskBackButton,
  EmptyState,
  dangerButton,
  enableButton,
  inputClass,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import type { AdminProviderQuickSetupId } from "@/components/admin/adminProviderQuickSetupApi";
import {
  deriveProviderUiState,
  type ProviderPrimaryAction
} from "@/components/admin/providerUiState";
import {
  PROVIDER_ADVANCED_TASK_LABELS,
  PROVIDER_ADVANCED_TASKS,
  preferredProviderConnectionId,
  presentProviderConnection,
  providerDeleteBlockerLabel,
  providerFamilyLabel,
  providerTaskForPrimaryAction,
  type ProviderAdvancedTask
} from "@/components/admin/providerAdvancedView";
import type {
  AdminConfirmationController,
  AdminConfirmationRequest
} from "@/components/admin/useAdminConfirmationController";
import { useAdminOpenRouterDiscovery } from "@/components/admin/useAdminOpenRouterDiscovery";
import {
  useAdminProvidersController,
  type AdminProvidersController
} from "@/components/admin/useAdminProvidersController";
import type { AdminGroup } from "@/lib/contracts/admin";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";
import {
  Check,
  ChevronRight,
  CircleAlert,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type AdminProvidersSectionProps = Readonly<{
  active: boolean;
  entryConnectionId?: string | null;
  entryProvider?: AdminProviderQuickSetupId | null;
  groups: AdminGroup[];
  onMutationCommitted?(): void | Promise<unknown>;
  requestConfirmation?: AdminConfirmationController["requestConfirmation"];
}>;

function Feedback({ controller }: Readonly<{ controller: AdminProvidersController }>) {
  if (
    controller.state.feedbackConnectionId &&
    controller.state.feedbackConnectionId !== controller.state.selectedConnection?.id
  ) {
    return null;
  }
  if (!controller.state.error && !controller.state.notice) return null;
  return (
    <div className="grid gap-2 border-b border-trace-subtle px-4 py-3 sm:px-6">
      {controller.state.error ? (
        <div className="flex items-start justify-between gap-3 rounded-control bg-critical/10 px-3 py-2 text-xs leading-5 text-critical" role="alert">
          <div className="min-w-0">
            <p>{controller.state.error}</p>
            {controller.state.errorBlockers.length ? (
              <ul className="mt-1 list-disc pl-4">
                {controller.state.errorBlockers.map((blocker) => (
                  <li key={blocker.kind}>{providerDeleteBlockerLabel(blocker)}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <button
            aria-label="Dismiss provider error"
            className={quietButton}
            onClick={controller.actions.dismissError}
            type="button"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      ) : null}
      {controller.state.notice ? (
        <div className="flex items-start justify-between gap-3 rounded-control bg-positive/10 px-3 py-2 text-xs leading-5 text-positive" role="status">
          <span>{controller.state.notice}</span>
          <button
            aria-label="Dismiss provider notice"
            className={quietButton}
            onClick={controller.actions.dismissNotice}
            type="button"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function publicationStatusClass(
  state: "active" | "changes_pending" | "not_configured"
): string {
  if (state === "active") return "text-positive";
  if (state === "changes_pending") return "text-caution";
  return "text-ink-muted";
}

function ConnectionIndex({
  connections,
  controller,
  onCreate,
  onQueryChange,
  onSelect,
  preferredFamily,
  query
}: Readonly<{
  connections: AdminProviderConnection[];
  controller: AdminProvidersController;
  onCreate(): void;
  onQueryChange(value: string): void;
  onSelect(id: string): void;
  preferredFamily?: AdminProviderQuickSetupId | null;
  query: string;
}>) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = connections.filter((connection) => !normalizedQuery || [
    connection.displayName,
    connection.family,
    providerFamilyLabel(connection.family)
  ].join(" ").toLocaleLowerCase().includes(normalizedQuery));
  const configuredCount = connections.filter(
    (connection) => presentProviderConnection(connection).publicationState !== "not_configured"
  ).length;

  return (
    <section
      aria-label="Provider connections"
      className="min-w-0 bg-workspace-rail/45 px-4 py-4 sm:px-6"
      data-testid="provider-connection-index"
    >
      <div className="min-w-0 overflow-hidden rounded-panel border border-trace-subtle bg-answer-paper">
        <div className="border-b border-trace-subtle bg-control-surface/60 px-4 py-3.5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-ink">Connections</h3>
              <p className="mt-0.5 text-xs text-ink-muted">
                {connections.length} {connections.length === 1 ? "connection" : "connections"} · {configuredCount} configured
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <button
                aria-label="Refresh provider connections"
                className={quietButton}
                disabled={controller.state.busy || controller.state.loading}
                onClick={() => void controller.actions.refresh()}
                type="button"
              >
                <RefreshCw aria-hidden="true" className={`size-3.5 ${controller.state.loading ? "animate-spin" : ""}`} />
                Refresh connections
              </button>
              <button className={primaryButton} disabled={controller.state.busy} onClick={onCreate} type="button">
                <Plus aria-hidden="true" className="size-3.5" />
                New
              </button>
            </div>
          </div>
          {connections.length > 6 ? (
            <label className="mt-3 block">
              <span className="sr-only">Search provider connections</span>
              <input
                className={inputClass}
                onChange={(event) => onQueryChange(event.currentTarget.value)}
                placeholder="Search connections"
                type="search"
                value={query}
              />
            </label>
          ) : null}
        </div>

        {filtered.length ? (
          <ul className="divide-y divide-trace-subtle">
            {filtered.map((connection) => {
              const presentation = presentProviderConnection(connection);
              const preferred = preferredFamily === connection.family;
              return (
                <li key={connection.id}>
                  <button
                    className={`flex min-h-touch w-full min-w-0 items-center gap-3 px-4 py-3 text-left hover:bg-control-hover ${adminAvailabilityRowClass(connection.enabled)}`}
                    data-resource-availability-row={connection.enabled ? "enabled" : "disabled"}
                    onClick={() => onSelect(connection.id)}
                    type="button"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">
                        {connection.displayName}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-ink-muted">
                        {providerFamilyLabel(connection.family)}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-2">
                        <AdminAvailabilityStatus enabled={connection.enabled} />
                        <span className={`text-xs font-medium ${publicationStatusClass(presentation.publicationState)}`}>
                          {presentation.publicationLabel}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-xs text-ink-muted">
                        {presentation.credentialCount} key{presentation.credentialCount === 1 ? "" : "s"} · {presentation.modelCount} model{presentation.modelCount === 1 ? "" : "s"}
                        {preferred ? " · Selected provider family" : ""}
                      </span>
                      {presentation.attention ? (
                        <span className="mt-1 block text-xs leading-5 text-caution">{presentation.attention}</span>
                      ) : null}
                    </span>
                    <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            detail={normalizedQuery ? "Clear the search or try a provider family." : "Create a provider connection to begin."}
            title={normalizedQuery ? "No matching connections" : "No provider connections"}
          />
        )}
      </div>
    </section>
  );
}

function runPrimaryAction(
  action: ProviderPrimaryAction,
  connection: AdminProviderConnection,
  controller: AdminProvidersController,
  setTask: (task: ProviderAdvancedTask) => void
) {
  if (action.kind === "activate") {
    void controller.actions.connectionAction(
      connection.id,
      { action: "activate", confirmUnavailable: false, enableConnection: true },
      "Provider draft activated and enabled for new runs."
    );
    return;
  }
  if (action.kind === "enable") {
    void controller.actions.connectionAction(
      connection.id,
      { action: "enable" },
      "Connection enabled for new runs."
    );
    return;
  }
  const task = providerTaskForPrimaryAction(action);
  setTask(task);
  if (action.kind === "add_model" || action.kind === "configure_credential") {
    window.setTimeout(() => {
      document.querySelector<HTMLButtonElement>(
        action.kind === "add_model"
          ? '[data-provider-action="add-model"]'
          : '[data-provider-action="add-key"]'
      )?.click();
    }, 0);
  }
}

function ConnectionDetail({
  connection,
  controller,
  discovery,
  groups,
  onBack,
  onEdit,
  requestConfirmation
}: Readonly<{
  connection: AdminProviderConnection;
  controller: AdminProvidersController;
  discovery: ReturnType<typeof useAdminOpenRouterDiscovery>;
  groups: AdminGroup[];
  onBack(): void;
  onEdit(): void;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
}>) {
  const ui = deriveProviderUiState(connection);
  const [activeTask, setActiveTask] = useState<ProviderAdvancedTask>(() =>
    providerTaskForPrimaryAction(ui.primaryAction)
  );
  const primaryActionIsAlreadyOpen = ui.primaryAction?.kind === "configure_credential" &&
    activeTask === "credentials" &&
    connection.credentials.length === 0;
  const primaryActionIsAlreadyInHeader = ui.primaryAction?.kind === "enable" &&
    Boolean(connection.activeConfig);
  const activationNeedsOverride =
    controller.state.feedbackConnectionId === connection.id &&
    controller.state.errorCode === "provider_activation_unavailable_confirmation_required";
  const firstSetupHasBlockers =
    ui.publication.kind === "not_configured" && ui.readiness.blockers.length > 0;
  const runtimeDisabled =
    ui.runtime.kind === "disabled" && ui.publication.kind !== "not_configured";
  const readinessTone = runtimeDisabled
    ? "disabled"
    : ui.readiness.blockers.length === 0
    ? "ready"
    : firstSetupHasBlockers
      ? "setup"
      : "attention";

  return (
    <div className="min-w-0" data-testid="provider-connection-detail">
      <div className="border-b border-trace-subtle px-4 py-4 sm:px-6">
        <AdminTaskBackButton alwaysVisible label="Back to connections" onClick={onBack} />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="break-words text-lg font-semibold text-ink">{connection.displayName}</h2>
              <AdminAvailabilityStatus enabled={connection.enabled} />
              <span className={`text-xs font-medium ${publicationStatusClass(ui.publication.kind)}`}>
                {ui.publication.label}
              </span>
            </div>
            <p className="mt-1 text-sm text-ink-muted">{providerFamilyLabel(connection.family)} connection</p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <button className={quietButton} disabled={controller.state.busy} onClick={onEdit} type="button">
              <Pencil aria-hidden="true" className="size-3.5" />
              Edit
            </button>
            {connection.activeConfig ? (
              <button
                className={connection.enabled ? quietButton : enableButton}
                disabled={controller.state.busy}
                onClick={() => void controller.actions.connectionAction(
                  connection.id,
                  { action: connection.enabled ? "disable" : "enable" },
                  connection.enabled
                    ? "Connection disabled for new runs."
                    : "Connection enabled for new runs."
                )}
                type="button"
              >
                {connection.enabled ? "Disable" : "Enable"}
              </button>
            ) : null}
            <button
              aria-label="Refresh provider connections"
              className={quietButton}
              disabled={controller.state.busy || controller.state.loading}
              onClick={() => void controller.actions.refresh()}
              type="button"
            >
              <RefreshCw aria-hidden="true" className={`size-3.5 ${controller.state.loading ? "animate-spin" : ""}`} />
              Refresh
            </button>
            <details className="relative">
              <summary
                aria-label={`More actions for ${connection.displayName} connection`}
                className={`${quietButton} cursor-pointer list-none`}
              >
                <MoreHorizontal aria-hidden="true" className="size-3.5" />
                More
              </summary>
              <div className="absolute right-0 top-full z-30 mt-1 grid min-w-64 gap-1 rounded-panel border border-trace-subtle bg-overlay-surface p-2 shadow-overlay">
                <div className="px-3 py-2">
                  <p className="break-all font-mono text-xs text-ink-muted">{connection.draftConfig.apiRoot}</p>
                  <p className="mt-1 text-xs text-ink-muted">
                    Draft v{connection.draftVersion}{connection.activeConfig ? ` · active v${connection.activeVersion}` : " · not activated"}
                  </p>
                </div>
                <button
                  aria-label={`Delete ${connection.displayName} connection`}
                  className={dangerButton}
                  disabled={controller.state.busy}
                  onClick={() => requestConfirmation({
                    body: connection.family === "openai_compatible"
                      ? "AIQSA will remove this custom connection, its models, encrypted credentials, assignments, model grants, and model defaults together. Active or recoverable runs, Assistant revisions, and model-backed Search strategies still block deletion so history and automation stay valid."
                      : "The connection can be deleted only after child credentials, models, grants, defaults, Assistant revisions, Search references, and live run bindings are removed.",
                    confirmLabel: connection.family === "openai_compatible"
                      ? "Delete connection and configuration"
                      : "Delete connection",
                    dialogLabel: `Delete ${connection.displayName} connection`,
                    icon: "trash",
                    onConfirm: async () => {
                      if (await controller.actions.deleteConnection(connection.id)) {
                        onBack();
                      }
                    },
                    testId: "admin-confirm-delete-provider-connection",
                    title: `Delete “${connection.displayName}”?`,
                    tone: "destructive"
                  })}
                  type="button"
                >
                  <Trash2 aria-hidden="true" className="size-3.5" />
                  Delete connection
                </button>
              </div>
            </details>
          </div>
        </div>

        <section
          className={[
            "mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
            readinessTone === "setup"
              ? "rounded-control border border-critical/30 bg-critical/10 px-3.5 py-3"
              : `border-l-2 pl-3 ${readinessTone === "ready" ? "border-positive" : readinessTone === "attention" ? "border-caution" : "border-trace-strong"}`
          ].join(" ")}
          aria-labelledby="provider-activation-readiness-heading"
          data-readiness-tone={readinessTone}
          data-testid="provider-activation-readiness"
        >
          <div className="flex min-w-0 items-start gap-2.5">
            {readinessTone === "setup" ? (
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden="true" />
            ) : null}
            <div className="min-w-0">
            <h3
              className={`text-sm font-semibold ${readinessTone === "setup" ? "text-critical" : readinessTone === "ready" ? "text-positive" : readinessTone === "attention" ? "text-caution" : runtimeDisabled ? "text-ink" : "text-ink-secondary"}`}
              id="provider-activation-readiness-heading"
            >
              {runtimeDisabled
                ? "Connection is disabled."
                : firstSetupHasBlockers
                ? "Complete setup before activation."
                : ui.readiness.blockers.length
                  ? ui.readiness.summary
                : ui.publication.kind === "active" && connection.enabled
                  ? "Provider is active and ready for new runs."
                  : "Ready to activate."}
            </h3>
            {ui.readiness.blockers.length ? (
              <ul className={`mt-1 list-disc space-y-1 pl-4 text-xs leading-5 ${readinessTone === "setup" ? "text-ink-secondary marker:text-critical" : "text-ink-muted"}`}>
                {ui.readiness.blockers.map((blocker) => <li key={blocker.code}>{blocker.message}</li>)}
              </ul>
            ) : (
              <p className="mt-1 text-xs leading-5 text-ink-muted">
                {runtimeDisabled
                  ? "Enable it when you want this provider to accept new runs."
                  : "Activation revalidates the current endpoint, models, and referenced keys on the server."}
              </p>
            )}
            </div>
          </div>
          {ui.primaryAction && !primaryActionIsAlreadyOpen && !primaryActionIsAlreadyInHeader ? (
            <button
              className={ui.primaryAction.kind === "enable" ? enableButton : primaryButton}
              disabled={controller.state.busy}
              onClick={() => runPrimaryAction(ui.primaryAction!, connection, controller, setActiveTask)}
              type="button"
            >
              {ui.primaryAction.kind === "activate" ? <Check aria-hidden="true" className="size-3.5" /> : null}
              {ui.primaryAction.label}
            </button>
          ) : null}
        </section>

        {activationNeedsOverride ? (
          <div className="mt-4 flex flex-col gap-3 rounded-control bg-caution/10 px-3 py-2.5 text-xs leading-5 text-caution sm:flex-row sm:items-center sm:justify-between">
            <p>One or more configured model IDs are absent from a referenced key catalog. Those exact pairs remain unavailable after an override.</p>
            <button
              className={quietButton}
              disabled={controller.state.busy}
              onClick={() => requestConfirmation({
                body: "Activation will keep every missing exact model/key pair unavailable. Existing active configuration is unchanged until this activation succeeds.",
                confirmLabel: "Activate with override",
                dialogLabel: `Activate ${connection.displayName} with unavailable models`,
                onConfirm: async () => {
                  await controller.actions.connectionAction(
                    connection.id,
                    { action: "activate", confirmUnavailable: true, enableConnection: true },
                    "Provider draft activated and enabled for new runs."
                  );
                },
                testId: "admin-confirm-provider-activation-override",
                title: "Activate with unavailable models?",
                tone: "warning"
              })}
              type="button"
            >
              Review override
            </button>
          </div>
        ) : null}
      </div>

      <div className="border-b border-trace-subtle px-4 py-3 sm:px-6">
        <label className="block sm:hidden">
          <span className="mb-1 block text-xs font-medium text-ink-secondary">Connection task</span>
          <select
            className={inputClass}
            onChange={(event) => setActiveTask(event.currentTarget.value as ProviderAdvancedTask)}
            value={activeTask}
          >
            {PROVIDER_ADVANCED_TASKS.map((task) => (
              <option key={task} value={task}>{PROVIDER_ADVANCED_TASK_LABELS[task]}</option>
            ))}
          </select>
        </label>
        <div className="hidden flex-wrap gap-1 sm:flex" role="tablist" aria-label="Connection tasks">
          {PROVIDER_ADVANCED_TASKS.map((task) => (
            <button
              aria-selected={activeTask === task}
              className={activeTask === task ? primaryButton : quietButton}
              key={task}
              onClick={() => setActiveTask(task)}
              role="tab"
              type="button"
            >
              {PROVIDER_ADVANCED_TASK_LABELS[task]}
            </button>
          ))}
        </div>
      </div>

      <div hidden={activeTask !== "credentials"}>
        <AdminProviderCredentialsTask
          connection={connection}
          controller={controller}
          requestConfirmation={requestConfirmation}
        />
      </div>
      <div hidden={activeTask !== "authentication"}>
        <AdminProviderAuthenticationTask connection={connection} controller={controller} groups={groups} />
      </div>
      <div hidden={activeTask !== "models"}>
        <AdminProviderModelsTask
          connection={connection}
          controller={controller}
          discovery={discovery}
          requestConfirmation={requestConfirmation}
        />
      </div>
      <div hidden={activeTask !== "diagnostics"}>
        <AdminProviderDiagnosticsTask
          connection={connection}
          controller={controller}
          requestConfirmation={requestConfirmation}
        />
      </div>
    </div>
  );
}

export function AdminProvidersSection({
  active,
  entryConnectionId = null,
  entryProvider = null,
  groups,
  onMutationCommitted,
  requestConfirmation: externalRequestConfirmation
}: AdminProvidersSectionProps) {
  const controller = useAdminProvidersController(active, { onMutationCommitted });
  const discovery = useAdminOpenRouterDiscovery({
    loadCompatibleModels: controller.actions.discoverCompatibleModels,
    loadEndpoints: controller.actions.discoverEndpoints,
    loadModels: controller.actions.discoverModels
  });
  const [connectionQuery, setConnectionQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);
  const [connectionTaskOpen, setConnectionTaskOpen] = useState(false);
  const [localConfirmation, setLocalConfirmation] = useState<AdminConfirmationRequest | null>(null);
  const handledEntryConnectionRef = useRef<string | null>(null);
  const handledEntryProviderRef = useRef<AdminProviderQuickSetupId | null>(null);
  const selected = controller.state.selectedConnection;
  const requestConfirmation = externalRequestConfirmation ?? setLocalConfirmation;

  useEffect(() => {
    if (
      !active ||
      !entryConnectionId ||
      !controller.state.loaded ||
      handledEntryConnectionRef.current === entryConnectionId ||
      !controller.state.connections.some(({ id }) => id === entryConnectionId)
    ) {
      return;
    }
    handledEntryConnectionRef.current = entryConnectionId;
    setCreating(false);
    setEditingConnectionId(null);
    controller.actions.select(entryConnectionId);
    setConnectionTaskOpen(true);
  }, [
    active,
    entryConnectionId,
    controller.actions,
    controller.state.connections,
    controller.state.loaded
  ]);

  useEffect(() => {
    if (
      !active ||
      entryConnectionId ||
      !entryProvider ||
      !controller.state.loaded ||
      handledEntryProviderRef.current === entryProvider
    ) {
      return;
    }
    handledEntryProviderRef.current = entryProvider;
    const connectionId = preferredProviderConnectionId(
      controller.state.connections,
      entryProvider
    );
    if (!connectionId) return;
    const openTimer = window.setTimeout(() => {
      setCreating(false);
      setEditingConnectionId(null);
      controller.actions.select(connectionId);
      setConnectionTaskOpen(true);
    }, 0);
    return () => window.clearTimeout(openTimer);
  }, [
    active,
    entryConnectionId,
    entryProvider,
    controller.actions,
    controller.state.connections,
    controller.state.loaded
  ]);

  const selectConnection = (id: string) => {
    setCreating(false);
    setEditingConnectionId(null);
    controller.actions.select(id);
    setConnectionTaskOpen(true);
  };

  return (
    <div className="min-w-0" data-testid="provider-connections-workspace">
      {controller.state.loading && !controller.state.loaded ? (
          <p className="px-4 py-12 text-center text-sm text-ink-muted" role="status">
            Loading provider connections…
          </p>
        ) : controller.state.loaded && controller.state.error && controller.state.connections.length === 0 ? (
          <div className="px-4 py-10 text-center sm:px-6" role="alert">
            <p className="text-sm font-semibold text-critical">Provider connections could not be loaded</p>
            <p className="mx-auto mt-1 max-w-xl text-sm leading-6 text-ink-muted">{controller.state.error}</p>
            <button className={`${quietButton} mt-4`} onClick={() => void controller.actions.refresh()} type="button">
              Retry provider refresh
            </button>
          </div>
        ) : (
          <>
            <Feedback controller={controller} />
            {connectionTaskOpen ? (
              <div className="min-w-0" data-testid="provider-connection-task-detail">
                {creating ? (
                  <div className="px-4 pt-4 sm:px-6">
                    <AdminTaskBackButton
                      alwaysVisible
                      label="Back to connections"
                      onClick={() => {
                        setCreating(false);
                        setConnectionTaskOpen(false);
                      }}
                    />
                    <AdminProviderConnectionEditor
                      connection={null}
                      controller={controller}
                      initialFamily={entryProvider}
                      onClose={() => {
                        setCreating(false);
                        setConnectionTaskOpen(false);
                      }}
                    />
                  </div>
                ) : selected ? (
                  <>
                    <div hidden={editingConnectionId !== selected.id}>
                      <div className="px-4 pt-4 sm:px-6">
                        <AdminTaskBackButton
                          alwaysVisible
                          label="Back to connection"
                          onClick={() => setEditingConnectionId(null)}
                        />
                      </div>
                      <AdminProviderConnectionEditor
                        connection={selected}
                        controller={controller}
                        onClose={() => setEditingConnectionId(null)}
                      />
                    </div>
                    <div hidden={editingConnectionId === selected.id}>
                      <ConnectionDetail
                        connection={selected}
                        controller={controller}
                        discovery={discovery}
                        groups={groups}
                        key={selected.id}
                        onBack={() => setConnectionTaskOpen(false)}
                        onEdit={() => setEditingConnectionId(selected.id)}
                        requestConfirmation={requestConfirmation}
                      />
                    </div>
                  </>
                ) : (
                  <EmptyState detail="Return to connections and choose one." title="Connection unavailable" />
                )}
              </div>
            ) : (
              <ConnectionIndex
                connections={controller.state.connections}
                controller={controller}
                onCreate={() => {
                  setCreating(true);
                  setEditingConnectionId(null);
                  setConnectionTaskOpen(true);
                }}
                onQueryChange={setConnectionQuery}
                onSelect={selectConnection}
                preferredFamily={entryProvider}
                query={connectionQuery}
              />
            )}
          </>
        )}

      {localConfirmation ? (
        <ConfirmationDialog
          confirmLabel={localConfirmation.confirmLabel}
          dialogLabel={localConfirmation.dialogLabel}
          icon={localConfirmation.icon}
          onCancel={() => setLocalConfirmation(null)}
          onConfirm={() => {
            const action = localConfirmation.onConfirm;
            setLocalConfirmation(null);
            void action();
          }}
          testId={localConfirmation.testId}
          title={localConfirmation.title}
          tone={localConfirmation.tone}
        >
          {localConfirmation.body}
        </ConfirmationDialog>
      ) : null}
    </div>
  );
}
