"use client";

import { focusRing, inputClass, touchTarget } from "@/components/admin/adminPrimitives";
import { AdminProviderModelSheet } from "@/components/admin/providers/models/AdminProviderModelSheet";
import { modelWorksWith, type ModelChip } from "@/components/admin/providers/models/modelChips";
import {
  activeModelCheck,
  checkableCredentials,
  diagnosticCheckRun,
  deriveModelUsage,
  embeddingModelLabel,
  groupProviderModels,
  liveConfiguration,
  modelRouteLabel,
  modelSuccessor,
  modelTitle,
  providerKeyFirstHelp,
  providerNeedsKeyForModels,
  turnOffConsequence
} from "@/components/admin/providers/models/modelListView";
import { useAdminOpenRouterDiscovery } from "@/components/admin/providers/models/useAdminOpenRouterDiscovery";
import { describeDeleteBlockers } from "@/components/admin/providers/providerBlockers";
import { visibleProviderModels, type ProviderUsageSources } from "@/components/admin/providers/providerListView";
import { ProviderRowMenu, ProviderTag } from "@/components/admin/providers/providerPrimitives";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminProvidersController } from "@/components/admin/useAdminProvidersController";
import {
  UiV2Button,
  UiV2Icon,
  UiV2MenuActions,
  UiV2Switch,
  type UiV2MenuAction
} from "@/components/ui-v2";
import { UiV2ResponsiveMenu } from "@/components/ui-v2/ResponsiveMenuV2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import type { AdminProviderConnection, AdminProviderModel } from "@/lib/contracts/adminProviders";
import { embeddingModelConfiguration, embeddingPresetsForFamily } from "@/lib/domain/embeddingModels";
import { adminRerankerModelConfiguration, rerankerPresetsForFamily } from "@/lib/domain/rerankerModels";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AdminProviderSetupProgress } from "@/components/admin/providers/add/AdminProviderSetupProgress";
import type { AdminProviderSetupProgress as SetupProgress } from "@/lib/contracts/adminProviderSetupProgress";

const USED_AS_LIMIT = 2;

const chipTone: Record<ModelChip["tone"], string> = {
  muted: "border-dashed border-trace-strong text-ink-muted",
  ok: "border-positive/30 bg-positive/10 text-positive",
  critical: "border-critical/30 bg-critical/10 text-critical font-semibold",
  warn: "border-caution/30 bg-caution/10 text-caution"
};

function Chip({ chip }: Readonly<{ chip: ModelChip }>) {
  const description = chip.key === "tools"
    ? "Ordinary function calling. Strict Memory calls are checked separately in Defaults & roles."
    : chip.key === "json" ? "Structured responses using a strict JSON Schema." : undefined;
  const help = [chip.help, description].filter(Boolean).join(" ") || undefined;
  return (
    <details className="min-w-0 max-w-full" onKeyDown={(event) => {
      if (event.key !== "Escape" || !event.currentTarget.open) return;
      event.stopPropagation();
      event.currentTarget.open = false;
      event.currentTarget.querySelector("summary")?.focus();
    }}>
      <summary
        aria-label={`${chip.label} capability details`}
        className={`inline-flex min-h-7 cursor-pointer list-none items-center gap-1 rounded-[6px] border px-1.5 text-metadata font-medium [&::-webkit-details-marker]:hidden ${focusRing} ${touchTarget} ${chipTone[chip.tone]}`}
        data-chip-tone={chip.tone}
        data-testid={`model-chip-${chip.key}`}
      >
        {chip.tone === "ok" ? <UiV2Icon aria-hidden="true" className="size-3" name="check" /> : null}
        {chip.label}
      </summary>
      <p className={`mt-1 max-h-40 max-w-72 overflow-y-auto break-words text-xs leading-5 text-ink-secondary ${focusRing}`} tabIndex={0}>
        {help ?? (chip.tone === "ok" ? "Verified with this key." : "This model is not available to the selected key.")}
      </p>
    </details>
  );
}

export type AdminProviderModelsProps = Readonly<{
  connection: AdminProviderConnection;
  controller: AdminProvidersController;
  diagnosticCredentialId: string | null;
  onDiagnosticCredentialChange(credentialId: string | null): void;
  onError(message: string): void;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
  usageSources: ProviderUsageSources;
}>;

function AddModelMenu({
  actions,
  descriptionId,
  disabled,
  onChatModel
}: Readonly<{
  actions: readonly UiV2MenuAction[];
  descriptionId?: string;
  disabled: boolean;
  onChatModel(): void;
}>) {
  const [open, setOpen] = useState(false);
  if (disabled && open) setOpen(false);
  const { closeForAction, menuRef, triggerRef } = useMenuDismissalV2({ onClose: () => setOpen(false), open });
  if (!actions.length) {
    return (
      <UiV2Button aria-describedby={descriptionId} data-testid="provider-add-model" disabled={disabled} icon="plus" onClick={onChatModel} tone="primary" type="button">
        Add model
      </UiV2Button>
    );
  }
  return (
    <div className="relative">
      <UiV2Button
        aria-describedby={descriptionId}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="provider-add-model"
        disabled={disabled}
        icon="plus"
        onClick={() => setOpen((value) => !value)}
        className="whitespace-nowrap"
        ref={triggerRef}
        tone="primary"
        type="button"
      >
        Add model
        <UiV2Icon className="ml-1 inline-block size-3.5 align-middle" name="chevron-down" />
      </UiV2Button>
      {open ? (
        <UiV2ResponsiveMenu anchorRef={triggerRef} className="min-w-[14rem]" label="Add model" menuRef={menuRef} onClose={() => setOpen(false)}>
          <UiV2MenuActions
            actions={[{ icon: "chat", label: "Chat model", onSelect: onChatModel }, ...actions]}
            onClose={closeForAction}
          />
        </UiV2ResponsiveMenu>
      ) : null}
    </div>
  );
}

/**
 * Models block of a provider page (PRD 5.4): one table grouped by class,
 * `Works with` chips from the last check with the selected key, `Used as`
 * tags, the On switch with its consequence dialog, the `⋯` actions, one
 * model editor, `Re-check all` and `Add model ▾`.
 */
export function AdminProviderModels({
  connection,
  controller,
  diagnosticCredentialId,
  onDiagnosticCredentialChange,
  onError,
  requestConfirmation,
  usageSources
}: AdminProviderModelsProps) {
  const [sheet, setSheet] = useState<Readonly<{ kind: "add" } | { kind: "edit"; model: AdminProviderModel }> | null>(null);
  const [presetProgress, setPresetProgress] = useState<SetupProgress | null>(null);
  const presetAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => presetAbortRef.current?.abort(), []);
  const discovery = useAdminOpenRouterDiscovery({
    loadCompatibleModels: controller.actions.discoverCompatibleModels,
    loadEndpoints: controller.actions.discoverEndpoints,
    loadModels: controller.actions.discoverModels
  });
  const busy = controller.state.busy || presetProgress !== null;
  const needsKey = providerNeedsKeyForModels(connection);
  const keyHelpId = useId();
  const usage = useMemo(() => deriveModelUsage(usageSources), [usageSources]);
  const groups = useMemo(() => groupProviderModels(visibleProviderModels(connection)), [connection]);
  const checkable = checkableCredentials(connection);
  const selectedKey = connection.credentials.find(({ id }) => id === diagnosticCredentialId) ?? null;
  const checkKey = checkable.find(({ id }) => id === diagnosticCredentialId) ?? null;
  const run = diagnosticCheckRun(connection, diagnosticCredentialId);
  const running = connection.checkRun?.state === "running";
  // Keep the edit baseline so a catalog refresh cannot replace fields or advance its CAS version.
  const editing = sheet?.kind === "edit" ? sheet.model : null;
  const initialSetup = connection.activeVersion === 0;
  const checkHelpId = useId();
  const hasCheckableModels = connection.models.some((model) => initialSetup || model.enabled && model.activeConfig !== null);
  const checkHelp = !checkKey ? selectedKey || diagnosticCredentialId
    ? "This key is unavailable. Choose a working key to check models."
    : "Choose a working API key to see its results and check models."
    : !hasCheckableModels ? "Add or turn on a model first."
      : running ? "Model checks are already running."
        : "Sends small requests to verify model access, tools, JSON output, PDF and image input, and streaming.";

  const startChecks = (credentialId: string, modelIds?: readonly string[]) => {
    onDiagnosticCredentialChange(credentialId);
    void controller.actions.startModelChecks(connection.id, credentialId, modelIds);
  };

  const setEnabled = (model: AdminProviderModel, enabled: boolean) => {
    const successMessage = enabled ? "Model turned on." : "Model turned off.";
    const apply = () => void controller.actions.updateModel(
      connection.id,
      model.id,
      { action: enabled ? "enable" : "disable" },
      successMessage
    );
    if (enabled) {
      apply();
      return;
    }
    const consequence = turnOffConsequence({
      model,
      successor: modelSuccessor(model.id, usageSources),
      tags: usage.get(model.id) ?? []
    });
    if (!consequence) {
      apply();
      return;
    }
    requestConfirmation({
      body: consequence.body,
      confirmLabel: "Turn off",
      dialogLabel: `Turn off ${model.displayName}`,
      icon: "x",
      onConfirm: apply,
      testId: "admin-confirm-turn-off-provider-model",
      title: consequence.title,
      tone: "warning"
    });
  };

  const requestRemove = (model: AdminProviderModel) => {
    requestConfirmation({
      body: "The model is removed from AIQSA together with its settings and check results. Chats already running finish, and history keeps its records.",
      confirmLabel: "Remove model",
      dialogLabel: `Remove ${model.displayName}`,
      icon: "trash",
      onConfirm: async () => {
        const result = await controller.actions.deleteModel(connection.id, model.id);
        if (!result.ok) {
          onError(`“${model.displayName}” was not removed. ${
            result.error.blockers.length ? describeDeleteBlockers(result.error.blockers, "model") : result.message
          }`);
        }
      },
      testId: "admin-confirm-delete-provider-model",
      title: `Remove “${model.displayName}” from AIQSA?`,
      tone: "destructive"
    });
  };

  const addPreset = (displayName: string, configuration: unknown) => {
    if (busy || needsKey || presetAbortRef.current) return;
    const abort = new AbortController();
    presetAbortRef.current = abort;
    setPresetProgress({ phase: "validating", completed: 0, total: null });
    void controller.actions.saveModel(connection.id, null, { configuration, displayName }, {
      signal: abort.signal,
      onProgress: (progress) => { if (!abort.signal.aborted) setPresetProgress(progress); }
    }).then((result) => {
      presetAbortRef.current = null;
      setPresetProgress(null);
      if (!result.ok) onError(`Setup for “${displayName}” did not finish. ${result.message}`);
    });
  };
  const presentUpstreamIds = new Set(connection.models.map((model) => liveConfiguration(model).upstreamModelId));
  const embeddingPresets = embeddingPresetsForFamily(connection.family)
    .filter((preset) => !presentUpstreamIds.has(preset.upstreamModelId));
  const rerankerPresets = rerankerPresetsForFamily(connection.family)
    .filter((preset) => !presentUpstreamIds.has(preset.upstreamModelId));
  const presetActions: UiV2MenuAction[] = [
    ...(embeddingPresetsForFamily(connection.family).length
      ? [{
          icon: "layers" as const,
          label: "Embedding preset",
          submenu: embeddingPresets.length
            ? embeddingPresets.map((preset) => ({
                label: embeddingModelLabel(preset.displayName, preset.targetDimension),
                onSelect: () => addPreset(preset.displayName, embeddingModelConfiguration(preset))
              }))
            : [{ label: "Every preset is already added", onSelect: () => undefined }]
        }]
      : []),
    ...(rerankerPresetsForFamily(connection.family).length
      ? [{
          icon: "sliders" as const,
          label: "Reranker preset",
          submenu: rerankerPresets.length
            ? rerankerPresets.map((preset) => ({
                label: preset.displayName,
                onSelect: () => addPreset(preset.displayName, adminRerankerModelConfiguration(preset))
              }))
            : [{ label: "Every preset is already added", onSelect: () => undefined }]
        }]
      : [])
  ];

  return (
    <section aria-labelledby="provider-models-heading" className="flex min-w-0 flex-col gap-2.5" data-testid="provider-models">
      {presetProgress ? <div>
        <AdminProviderSetupProgress progress={presetProgress} />
        <UiV2Button className="mt-2" onClick={() => presetAbortRef.current?.abort()} tone="ghost" type="button">Stop checking</UiV2Button>
      </div> : null}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-ink" id="provider-models-heading">Models</h3>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {groups.length ? (
            <UiV2Button
              aria-describedby={checkHelpId}
              disabled={busy || running || !checkKey || !hasCheckableModels}
              icon="regenerate"
              onClick={() => checkKey && startChecks(checkKey.id)}
              title={checkHelp}
              tone="ghost"
              type="button"
            >
              Check models
            </UiV2Button>
          ) : null}
          <AddModelMenu actions={presetActions} descriptionId={needsKey ? keyHelpId : undefined} disabled={busy || needsKey} onChatModel={() => { if (!busy && !needsKey) setSheet({ kind: "add" }); }} />
        </div>
      </div>

      {needsKey ? <p className="text-sm text-ink-secondary" id={keyHelpId}>{providerKeyFirstHelp}</p> : null}

      <label className="flex min-w-0 flex-wrap items-center gap-2 text-[13px] text-ink-secondary">
        <span>Check results for key</span>
        <select
          className={`${inputClass} h-8 min-h-0 w-full py-0 text-[13px] sm:w-64`}
          onChange={(event) => onDiagnosticCredentialChange(event.currentTarget.value || null)}
          value={diagnosticCredentialId ?? ""}
        >
          <option value="">Choose a key</option>
          {diagnosticCredentialId && !selectedKey ? <option value={diagnosticCredentialId}>Selected key unavailable</option> : null}
          {connection.credentials.map((credential) => (
            <option disabled={!checkable.some(({ id }) => id === credential.id)} key={credential.id} value={credential.id}>
              {credential.label}{!checkable.some(({ id }) => id === credential.id) ? " · unavailable" : ""}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs leading-5 text-ink-muted" id={checkHelpId}>
        {checkHelp} Selecting a key here only changes diagnostics; it does not change anyone’s access.
      </p>

      <div className="overflow-hidden rounded-[12px] border border-trace-subtle bg-answer-paper">
        {groups.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-ink-muted" role="status">
            {needsKey ? "Models appear after a working key is saved." : "No models yet. Add one to make this provider usable in chat."}
          </p>
        ) : (
          <div className="xl:overflow-x-auto">
            <table aria-label="Models" className="block w-full border-collapse text-sm xl:table xl:min-w-[42rem]">
              <thead className="sr-only xl:not-sr-only xl:table-header-group">
                <tr className="border-b border-trace-subtle text-left text-metadata font-semibold uppercase tracking-[0.06em] text-ink-muted">
                  <th className="px-4 py-2.5 font-semibold sm:px-5" scope="col">Model</th>
                  <th className="px-3 py-2.5 font-semibold" scope="col">Works with</th>
                  <th className="px-3 py-2.5 font-semibold" scope="col">Used as</th>
                  <th className="px-3 py-2.5 font-semibold" scope="col">On</th>
                  <th className="relative px-3 py-2.5" scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              {groups.map((group) => (
                <tbody className="block xl:table-row-group" data-testid={`provider-models-${group.modelClass}`} key={group.modelClass}>
                  <tr className="block border-b border-trace-subtle bg-control-surface/40 xl:table-row">
                    <th
                      className="block px-4 py-1.5 text-left text-metadata font-semibold uppercase tracking-[0.06em] text-ink-muted xl:table-cell sm:px-5"
                      colSpan={5}
                      scope="rowgroup"
                    >
                      {group.title} · {group.models.length}
                    </th>
                  </tr>
                  {group.models.map((model) => {
                    const configuration = liveConfiguration(model);
                    const check = activeModelCheck(connection, model, checkKey);
                    const worksWith = modelWorksWith({
                      check,
                      checkRun: run && (!model.activatedAt || Date.parse(model.activatedAt) <= Date.parse(run.startedAt)) ? run : null,
                      configuration,
                      defaultCredentialId: diagnosticCredentialId,
                      modelId: model.id
                    });
                    const tags = usage.get(model.id) ?? [];
                    const route = modelRouteLabel(connection, model);
                    const canCheck = !busy && Boolean(checkKey) && (initialSetup || model.enabled && model.activeConfig !== null) && !running;
                    const menu: UiV2MenuAction[] = [
                      { icon: "edit", label: "Edit", onSelect: () => setSheet({ kind: "edit", model }) },
                      {
                        disabled: busy || running || !checkable.length || !model.enabled || model.activeConfig === null,
                        icon: "regenerate",
                        label: "Re-check with key…",
                        submenu: checkable.map((credential) => ({
                          label: credential.label,
                          onSelect: () => startChecks(credential.id, [model.id])
                        }))
                      },
                      {
                        icon: "stop",
                        label: model.enabled ? "Turn off" : "Turn on",
                        onSelect: () => setEnabled(model, !model.enabled),
                        separatorBefore: true
                      },
                      { icon: "trash", label: "Remove from AIQSA", onSelect: () => requestRemove(model), tone: "destructive" }
                    ];
                    return (
                      <tr
                        className={`grid grid-cols-[minmax(0,1fr)_auto_auto] border-b border-trace-subtle align-top xl:table-row ${model.enabled ? "" : "opacity-70"}`}
                        data-model-enabled={model.enabled}
                        data-testid={`provider-model-${model.id}`}
                        id={`provider-model-${model.id}`}
                        key={model.id}
                      >
                        <td className="col-start-1 row-start-1 min-w-0 px-4 py-3 sm:max-w-[18rem] sm:px-5">
                          <span className="block truncate text-sm font-medium text-ink" data-testid="provider-model-name">{modelTitle(model)}</span>
                          <p className="mt-0.5 truncate text-xs text-ink-muted">
                            <span className="font-mono">{configuration.upstreamModelId}</span>
                            {route ? ` · ${route}` : ""}
                            {worksWith.kind === "not_checked" ? " · not checked yet" : ""}
                          </p>
                        </td>
                        <td className="col-span-3 row-start-2 min-w-0 px-4 pb-3 sm:px-3 sm:py-3" data-testid={`provider-model-${model.id}-works-with`} data-works-with={worksWith.kind}>
                          {worksWith.kind === "checking" ? (
                            <span className="inline-flex items-center gap-2 text-xs text-ink-secondary" role="status">
                              <span aria-hidden="true" className="v2-spinner" />
                              {worksWith.label}
                            </span>
                          ) : worksWith.kind === "not_checked" ? (
                            <span className="inline-flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                              not checked yet
                              <UiV2Button aria-describedby={checkHelpId} disabled={!canCheck} onClick={() => checkKey && startChecks(checkKey.id, [model.id])} title={checkHelp} tone="ghost" type="button">
                                Check model
                              </UiV2Button>
                              {!model.enabled && !initialSetup ? <span>Turn this model on to check it.</span> : null}
                            </span>
                          ) : (
                            <div className="flex flex-wrap items-start gap-1.5">
                              {worksWith.chips.map((chip) => <Chip chip={chip} key={chip.key} />)}
                              {worksWith.kind === "failed" ? <span className="text-xs text-ink-muted">No completed check. Use Re-check with key… in the model menu.</span> : null}
                            </div>
                          )}
                        </td>
                        <td className={`col-span-3 row-start-3 min-w-0 px-4 pb-3 sm:px-3 sm:py-3 ${tags.length ? "" : "hidden xl:table-cell"}`}>
                          <span className="flex flex-wrap items-center gap-1">
                            {tags.slice(0, USED_AS_LIMIT).map((tag) => <ProviderTag key={tag}>{tag}</ProviderTag>)}
                            {tags.length > USED_AS_LIMIT ? <ProviderTag>+{tags.length - USED_AS_LIMIT}</ProviderTag> : null}
                          </span>
                        </td>
                        <td className="col-start-2 row-start-1 px-2 py-2.5 sm:px-3">
                          <UiV2Switch
                            checked={model.enabled}
                            disabled={busy}
                            label={`${model.displayName} on`}
                            onChange={(next) => setEnabled(model, next)}
                          />
                        </td>
                        <td className="col-start-3 row-start-1 px-3 py-2.5 text-right">
                          <ProviderRowMenu actions={menu} label={`More actions for ${model.displayName}`} tooltipSide="top" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
        )}
      </div>
      <p className="text-xs leading-5 text-ink-muted">
        {running
          ? "Models are usable in chat as soon as the key works. Check results only decide which internal roles a model can serve, and are shown here so you never have to run them by hand."
          : "Turning a model off hides it from new chats immediately. A model that serves a role or a Search source shows it under “Used as” and asks before you turn it off."}
      </p>

      <AdminProviderModelSheet
        connection={connection}
        controller={controller}
        discovery={discovery}
        diagnosticCredentialId={diagnosticCredentialId}
        key={sheet ? `${sheet.kind}:${editing?.id ?? "new"}` : "closed"}
        model={editing}
        onClose={() => setSheet(null)}
        onSaved={() => setSheet(null)}
        open={sheet !== null && (sheet.kind === "add" || editing !== null)}
      />
    </section>
  );
}
