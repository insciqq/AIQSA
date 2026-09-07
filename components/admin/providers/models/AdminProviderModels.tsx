"use client";

import { AdminProviderModelSheet } from "@/components/admin/providers/models/AdminProviderModelSheet";
import { modelWorksWith, type ModelChip } from "@/components/admin/providers/models/modelChips";
import {
  activeModelCheck,
  checkableCredentials,
  defaultCredentialOf,
  deriveModelUsage,
  embeddingModelLabel,
  groupProviderModels,
  liveConfiguration,
  modelCheckSummaries,
  modelRouteLabel,
  modelSuccessor,
  modelTitle,
  turnOffConsequence
} from "@/components/admin/providers/models/modelListView";
import { useAdminOpenRouterDiscovery } from "@/components/admin/providers/models/useAdminOpenRouterDiscovery";
import { describeDeleteBlockers } from "@/components/admin/providers/providerBlockers";
import type { ProviderUsageSources } from "@/components/admin/providers/providerListView";
import { ProviderRowMenu, ProviderTag } from "@/components/admin/providers/providerPrimitives";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminProvidersController } from "@/components/admin/useAdminProvidersController";
import {
  UiV2Button,
  UiV2Icon,
  UiV2MenuActions,
  UiV2MenuSurface,
  UiV2Switch,
  type UiV2MenuAction
} from "@/components/ui-v2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import type { AdminProviderConnection, AdminProviderModel } from "@/lib/contracts/adminProviders";
import { embeddingPresetsForFamily, type EmbeddingModelPreset } from "@/lib/domain/embeddingModels";
import { adminRerankerModelConfiguration, rerankerPresetsForFamily } from "@/lib/domain/rerankerModels";
import { useMemo, useState, type MouseEvent } from "react";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-answer-paper";
const USED_AS_LIMIT = 2;

const chipTone: Record<ModelChip["tone"], string> = {
  muted: "border-dashed border-trace-strong text-ink-muted",
  ok: "border-positive/30 bg-positive/10 text-positive",
  warn: "border-caution/30 bg-caution/10 text-caution"
};

function Chip({ chip }: Readonly<{ chip: ModelChip }>) {
  return (
    <span
      className={`inline-flex h-[22px] shrink-0 items-center gap-1 whitespace-nowrap rounded-[6px] border px-1.5 text-metadata font-medium ${chipTone[chip.tone]}`}
      data-chip-tone={chip.tone}
      data-testid={`model-chip-${chip.key}`}
    >
      {chip.tone === "ok" ? <UiV2Icon className="size-3" name="check" /> : null}
      {chip.label}
    </span>
  );
}

export type AdminProviderModelsProps = Readonly<{
  connection: AdminProviderConnection;
  controller: AdminProvidersController;
  onError(message: string): void;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
  usageSources: ProviderUsageSources;
}>;

function embeddingPresetConfiguration(preset: EmbeddingModelPreset) {
  return {
    adapterKind: "openai_embeddings_compatible" as const,
    answerSelectable: false,
    capabilities: {
      contextWindow: preset.contextWindow,
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      streaming: false,
      toolCalling: false,
      vision: false
    },
    defaultParams: {},
    embedding: {
      nativeDimension: preset.nativeDimension,
      providerFamily: preset.providerFamily,
      queryInstructionTemplate: preset.queryInstructionTemplate,
      supportsMrl: preset.supportsMrl,
      targetDimension: preset.targetDimension
    },
    modelClass: "embedding" as const,
    ...(preset.providerFamily === "openrouter"
      ? {
          openRouterRouting: preset.openRouterProviderTags?.length
            ? { mode: "only_selected" as const, providers: [...preset.openRouterProviderTags] }
            : { mode: "automatic" as const, providers: [] as [] }
        }
      : {}),
    upstreamModelId: preset.upstreamModelId
  };
}

function AddModelMenu({
  actions,
  disabled,
  onChatModel
}: Readonly<{
  actions: readonly UiV2MenuAction[];
  disabled: boolean;
  onChatModel(): void;
}>) {
  const [open, setOpen] = useState(false);
  const { menuRef, triggerRef } = useMenuDismissalV2({ onClose: () => setOpen(false), open });
  if (!actions.length) {
    return (
      <UiV2Button data-testid="provider-add-model" disabled={disabled} icon="plus" onClick={onChatModel} tone="primary" type="button">
        Add model
      </UiV2Button>
    );
  }
  return (
    <div className="relative">
      <UiV2Button
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
        <UiV2Icon className="ml-1 size-3.5" name="chevron-down" />
      </UiV2Button>
      {open ? (
        <UiV2MenuSurface className="absolute right-0 top-[calc(100%+0.375rem)] z-30 min-w-[14rem]" label="Add model" ref={menuRef}>
          <UiV2MenuActions
            actions={[{ icon: "chat", label: "Chat model", onSelect: onChatModel }, ...actions]}
            onClose={() => setOpen(false)}
          />
        </UiV2MenuSurface>
      ) : null}
    </div>
  );
}

/**
 * Models block of a provider page (PRD 5.4): one table grouped by class,
 * `Works with` chips from the last check with the default key, `Used as`
 * tags, the On switch with its consequence dialog, the `⋯` actions, one
 * expandable row, `Re-check all` and `Add model ▾`.
 */
export function AdminProviderModels({
  connection,
  controller,
  onError,
  requestConfirmation,
  usageSources
}: AdminProviderModelsProps) {
  const [sheet, setSheet] = useState<Readonly<{ kind: "add" } | { kind: "edit"; modelId: string }> | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const discovery = useAdminOpenRouterDiscovery({
    loadCompatibleModels: controller.actions.discoverCompatibleModels,
    loadEndpoints: controller.actions.discoverEndpoints,
    loadModels: controller.actions.discoverModels
  });
  const busy = controller.state.busy;
  const usage = useMemo(() => deriveModelUsage(usageSources), [usageSources]);
  const groups = useMemo(() => groupProviderModels(connection.models), [connection.models]);
  const defaultCredential = defaultCredentialOf(connection);
  const checkable = checkableCredentials(connection);
  const checkKey = defaultCredential && checkable.some(({ id }) => id === defaultCredential.id) ? defaultCredential : null;
  const run = connection.checkRun ?? null;
  const running = run?.state === "running";
  const editing = sheet?.kind === "edit" ? connection.models.find(({ id }) => id === sheet.modelId) ?? null : null;
  const hasCheckableModels = connection.models.some((model) => model.enabled && model.activeConfig !== null);

  const startChecks = (credentialId: string, modelIds?: readonly string[]) =>
    void controller.actions.startModelChecks(connection.id, credentialId, modelIds);

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
    void controller.actions.saveModel(connection.id, null, { configuration, displayName }).then((result) => {
      if (!result.ok) onError(`“${displayName}” was not added. ${result.message}`);
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
                onSelect: () => addPreset(preset.displayName, embeddingPresetConfiguration(preset))
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

  const rowClick = (event: MouseEvent<HTMLTableRowElement>, modelId: string) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, select, [role='menu'], [role='dialog']")) return;
    setExpandedId((current) => current === modelId ? null : modelId);
  };

  return (
    <section aria-labelledby="provider-models-heading" className="flex min-w-0 flex-col gap-2.5" data-testid="provider-models">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-ink" id="provider-models-heading">Models</h3>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {connection.models.length ? (
            <UiV2Button
              disabled={busy || running || !checkKey || !hasCheckableModels}
              icon="regenerate"
              onClick={() => checkKey && startChecks(checkKey.id)}
              title={checkKey ? undefined : "Add a working default key first"}
              tone="ghost"
              type="button"
            >
              Re-check all
            </UiV2Button>
          ) : null}
          <AddModelMenu actions={presetActions} disabled={busy} onChatModel={() => setSheet({ kind: "add" })} />
        </div>
      </div>

      <div className="overflow-hidden rounded-[12px] border border-trace-subtle bg-answer-paper">
        {groups.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-ink-muted" role="status">
            No models yet. Add one to make this provider usable in chat.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Models" className="w-full min-w-[42rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-trace-subtle text-left text-metadata font-semibold uppercase tracking-[0.06em] text-ink-muted">
                  <th className="px-4 py-2.5 font-semibold sm:px-5" scope="col">Model</th>
                  <th className="px-3 py-2.5 font-semibold" scope="col">Works with</th>
                  <th className="px-3 py-2.5 font-semibold" scope="col">Used as</th>
                  <th className="px-3 py-2.5 font-semibold" scope="col">On</th>
                  <th className="relative px-3 py-2.5" scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              {groups.map((group) => (
                <tbody data-testid={`provider-models-${group.modelClass}`} key={group.modelClass}>
                  <tr className="border-b border-trace-subtle bg-control-surface/40">
                    <th
                      className="px-4 py-1.5 text-left text-metadata font-semibold uppercase tracking-[0.06em] text-ink-muted sm:px-5"
                      colSpan={5}
                      scope="rowgroup"
                    >
                      {group.title} · {group.models.length}
                    </th>
                  </tr>
                  {group.models.map((model) => {
                    const configuration = liveConfiguration(model);
                    const check = activeModelCheck(connection, model, defaultCredential);
                    const worksWith = modelWorksWith({
                      check,
                      checkRun: run,
                      configuration,
                      defaultCredentialId: connection.defaultCredentialId,
                      modelId: model.id
                    });
                    const tags = usage.get(model.id) ?? [];
                    const route = modelRouteLabel(connection, model);
                    const expanded = expandedId === model.id;
                    const summaries = expanded ? modelCheckSummaries(connection, model) : [];
                    const canCheck = Boolean(checkKey) && model.enabled && model.activeConfig !== null && !running;
                    const menu: UiV2MenuAction[] = [
                      { icon: "edit", label: "Edit", onSelect: () => setSheet({ kind: "edit", modelId: model.id }) },
                      {
                        disabled: !checkable.length || !model.enabled || model.activeConfig === null,
                        icon: "regenerate",
                        label: "Re-check with key…",
                        submenu: checkable.map((credential) => ({
                          label: credential.label,
                          onSelect: () => startChecks(credential.id, [model.id])
                        }))
                      },
                      { icon: "search", label: "Details", onSelect: () => setExpandedId(model.id) },
                      {
                        icon: "stop",
                        label: model.enabled ? "Turn off" : "Turn on",
                        onSelect: () => setEnabled(model, !model.enabled),
                        separatorBefore: true
                      },
                      { icon: "trash", label: "Remove from AIQSA", onSelect: () => requestRemove(model), tone: "destructive" }
                    ];
                    return [
                      <tr
                        aria-expanded={expanded}
                        className={`border-b border-trace-subtle align-top ${model.enabled ? "" : "opacity-70"} ${expanded ? "bg-control-surface/30" : ""}`}
                        data-model-enabled={model.enabled}
                        data-testid={`provider-model-${model.id}`}
                        key={model.id}
                        onClick={(event) => rowClick(event, model.id)}
                      >
                        <td className="min-w-0 max-w-[18rem] px-4 py-3 sm:px-5">
                          <button
                            aria-expanded={expanded}
                            className={`block min-w-0 max-w-full text-left ${focusRing} rounded-[4px]`}
                            onClick={() => setExpandedId((current) => current === model.id ? null : model.id)}
                            type="button"
                          >
                            <span className="block truncate text-sm font-medium text-ink">{modelTitle(model)}</span>
                          </button>
                          <p className="mt-0.5 truncate text-xs text-ink-muted">
                            <span className="font-mono">{configuration.upstreamModelId}</span>
                            {route ? ` · ${route}` : ""}
                            {worksWith.kind === "not_checked" ? " · not checked yet" : ""}
                          </p>
                        </td>
                        <td className="px-3 py-3" data-testid={`provider-model-${model.id}-works-with`} data-works-with={worksWith.kind}>
                          {worksWith.kind === "checking" ? (
                            <span className="inline-flex items-center gap-2 text-xs text-ink-secondary" role="status">
                              <span aria-hidden="true" className="v2-spinner" />
                              {worksWith.label}
                            </span>
                          ) : worksWith.kind === "not_checked" ? (
                            <span className="inline-flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                              not checked yet
                              <UiV2Button disabled={!canCheck} onClick={() => checkKey && startChecks(checkKey.id, [model.id])} tone="ghost" type="button">
                                Check
                              </UiV2Button>
                            </span>
                          ) : (
                            <span className="flex flex-wrap items-center gap-1.5">
                              {worksWith.chips.map((chip) => <Chip chip={chip} key={chip.key} />)}
                              {worksWith.kind === "failed" ? (
                                <span className="inline-flex items-center gap-2 text-xs text-caution">
                                  Check failed
                                  <UiV2Button disabled={!canCheck} onClick={() => checkKey && startChecks(checkKey.id, [model.id])} tone="ghost" type="button">
                                    Retry
                                  </UiV2Button>
                                </span>
                              ) : null}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <span className="flex flex-wrap items-center gap-1">
                            {tags.slice(0, USED_AS_LIMIT).map((tag) => <ProviderTag key={tag}>{tag}</ProviderTag>)}
                            {tags.length > USED_AS_LIMIT ? <ProviderTag>+{tags.length - USED_AS_LIMIT}</ProviderTag> : null}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <UiV2Switch
                            checked={model.enabled}
                            disabled={busy}
                            label={`${model.displayName} on`}
                            onChange={(next) => setEnabled(model, next)}
                          />
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <ProviderRowMenu actions={menu} label={`More actions for ${model.displayName}`} />
                        </td>
                      </tr>,
                      expanded ? (
                        <tr className="border-b border-trace-subtle" data-testid={`provider-model-${model.id}-details`} key={`${model.id}-details`}>
                          <td className="px-4 pb-3.5 sm:px-5" colSpan={5}>
                            <div className="flex min-w-0 flex-col gap-3 rounded-[10px] bg-control-surface/60 px-3.5 py-3 sm:flex-row sm:items-center">
                              <div className="min-w-0 flex-1 text-xs leading-5 text-ink-secondary">
                                {summaries.length ? summaries.map((summary) => (
                                  <p key={summary.credentialLabel}>
                                    {summary.sentence}
                                    {summary.usageMissing ? (
                                      <span className="block text-caution">No usage reporting — cost accounting for this model will be empty.</span>
                                    ) : null}
                                  </p>
                                )) : worksWith.kind === "checking" ? (
                                  <p>Checking with key {checkKey?.label ?? "the default key"}…</p>
                                ) : worksWith.kind === "failed" ? (
                                  <p>The last check hit a temporary provider failure; earlier results were kept.</p>
                                ) : (
                                  <p>{checkKey ? `Not checked yet with key ${checkKey.label}.` : "Add a working default key to check this model."}</p>
                                )}
                                {route ? <p className="text-ink-muted">Route: {route}.</p> : null}
                              </div>
                              <div className="flex shrink-0 items-center gap-2">
                                <UiV2Button
                                  disabled={!canCheck}
                                  onClick={() => checkKey && startChecks(checkKey.id, [model.id])}
                                  tone="ghost"
                                  type="button"
                                >
                                  Re-check
                                </UiV2Button>
                                <UiV2Button icon="edit" onClick={() => setSheet({ kind: "edit", modelId: model.id })} tone="ghost" type="button">
                                  Edit
                                </UiV2Button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null
                    ];
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
        key={sheet ? `${sheet.kind}:${sheet.kind === "edit" ? `${sheet.modelId}:${editing?.draftVersion ?? 0}` : "new"}` : "closed"}
        model={editing}
        onClose={() => setSheet(null)}
        onSaved={() => setSheet(null)}
        open={sheet !== null && (sheet.kind === "add" || editing !== null)}
      />
    </section>
  );
}
