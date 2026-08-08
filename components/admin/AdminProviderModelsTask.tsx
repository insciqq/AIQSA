"use client";

import {
  AdminProviderModelEditor,
  adminProviderAdapterLabel
} from "@/components/admin/AdminProviderModelEditor";
import {
  AdminAvailabilityStatus,
  adminAvailabilityRowClass,
  EmptyState,
  dangerButton,
  enableButton,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import { presentProviderModel } from "@/components/admin/providerAdvancedView";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminOpenRouterDiscoverySession } from "@/components/admin/useAdminOpenRouterDiscovery";
import type { AdminProvidersController } from "@/components/admin/useAdminProvidersController";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";
import {
  embeddingPresetsForFamily,
  type EmbeddingModelPreset
} from "@/lib/domain/embeddingModels";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

export function AdminProviderModelsTask({
  connection,
  controller,
  discovery,
  requestConfirmation
}: Readonly<{
  connection: AdminProviderConnection;
  controller: AdminProvidersController;
  discovery: AdminOpenRouterDiscoverySession;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
}>) {
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const editing = editingId && editingId !== "new"
    ? connection.models.find(({ id }) => id === editingId) ?? null
    : null;
  const embeddingPresets = embeddingPresetsForFamily(connection.family);

  function addOrEnableEmbeddingPreset(preset: EmbeddingModelPreset) {
    const existing = connection.models.find((model) =>
      (model.modelClass ?? model.draftConfig.modelClass ?? "answer") === "embedding" &&
      model.draftConfig.upstreamModelId === preset.upstreamModelId
    );
    if (existing) {
      if (!existing.enabled) {
        void controller.actions.updateModel(
          connection.id,
          existing.id,
          { action: "enable" },
          `${preset.displayName} embedding deployment enabled.`
        );
      }
      return;
    }
    void controller.actions.createModel(connection.id, {
      configuration: {
        adapterKind: "openai_embeddings_compatible",
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
        modelClass: "embedding",
        upstreamModelId: preset.upstreamModelId
      },
      displayName: preset.displayName
    });
  }

  return (
    <section
      className="min-w-0 bg-workspace-rail/45 px-4 py-4 sm:px-6"
      data-testid="provider-task-models"
    >
      <div className="min-w-0 rounded-panel border border-trace-subtle bg-answer-paper">
        <div className="flex flex-col gap-3 rounded-t-panel border-b border-trace-subtle bg-control-surface/60 px-4 py-3.5 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-3xl">
            <h3 className="text-base font-semibold text-ink">Models</h3>
            <p className="mt-1 text-sm leading-6 text-ink-muted">
              {connection.family === "openai_compatible"
                ? "Each deployment chooses Responses or Chat Completions explicitly."
                : connection.family === "gemini"
                  ? "Each deployment uses the native Gemini Interactions protocol."
                : connection.family === "openrouter"
                  ? "Choose from the selected account catalog, then keep Automatic routing or define one ordered provider allowlist."
                  : "Each row is one concrete deployment that becomes available for grants only after activation."}
            </p>
          </div>
          <button
            aria-controls="provider-model-editor"
            aria-expanded={editingId === "new"}
            className={editingId === "new" ? quietButton : primaryButton}
            data-provider-action="add-model"
            disabled={controller.state.busy}
            onClick={() => setEditingId((current) => current === "new" ? null : "new")}
            type="button"
          >
            <Plus aria-hidden="true" className="size-3.5" />
            {editingId === "new" ? "Close model form" : "Add model"}
          </button>
        </div>

        {embeddingPresets.length ? (
          <div className="border-b border-trace-subtle bg-workspace-rail/35 px-4 py-4">
            <div className="max-w-3xl">
              <h4 className="text-sm font-semibold text-ink">Embedding presets</h4>
              <p className="mt-1 text-xs leading-5 text-ink-muted">
                Add an exact vector deployment to this connection. AIQSA always requests the native vector, then truncates and normalizes locally.
              </p>
            </div>
            <div className="mt-3 divide-y divide-trace-subtle border-y border-trace-subtle">
              {embeddingPresets.map((preset) => {
                const existing = connection.models.find((model) =>
                  (model.modelClass ?? model.draftConfig.modelClass ?? "answer") === "embedding" &&
                  model.draftConfig.upstreamModelId === preset.upstreamModelId
                );
                return (
                  <div className="flex min-w-0 flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between" key={preset.id}>
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium text-ink">
                        {preset.displayName}{preset.default ? " · Default" : ""}
                      </p>
                      <p className="mt-1 font-mono text-metadata text-proof">
                        {preset.nativeDimension.toLocaleString()} → {preset.targetDimension.toLocaleString()} dimensions
                        {preset.queryInstructionTemplate ? " · instructed queries / bare documents" : " · symmetric text input"}
                      </p>
                      <p className="mt-1 max-w-3xl text-xs leading-5 text-ink-muted">{preset.description}</p>
                    </div>
                    <button
                      aria-label={`${existing?.enabled ? "Added" : existing ? "Enable" : "Add"} ${preset.displayName} embedding preset`}
                      className={existing?.enabled ? quietButton : primaryButton}
                      disabled={controller.state.busy || existing?.enabled === true}
                      onClick={() => addOrEnableEmbeddingPreset(preset)}
                      type="button"
                    >
                      <Plus aria-hidden="true" className="size-3.5" />
                      {existing?.enabled ? "Added" : existing ? "Enable" : "Add preset"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {editingId ? (
          <div className="border-b border-trace-subtle px-4 py-4">
            <AdminProviderModelEditor
              connection={connection}
              controller={controller}
              discovery={discovery}
              editing={editing}
              key={`${connection.id}:${editingId}:${editing?.draftVersion ?? 0}`}
              onClose={() => setEditingId(null)}
            />
          </div>
        ) : null}

        {connection.models.length ? (
          <div aria-label="Configured models" className="divide-y divide-trace-subtle" role="list">
            {connection.models.map((model) => {
              const presentation = presentProviderModel(model);
              const isEmbedding = (model.modelClass ?? model.draftConfig.modelClass ?? "answer") === "embedding";
              const embedding = model.draftConfig.embedding;
              const routing = model.draftConfig.openRouterRouting;
              const routingText = isEmbedding && embedding
                ? `${embedding.nativeDimension.toLocaleString()} → ${embedding.targetDimension.toLocaleString()} dimensions`
                : routing?.mode === "only_selected"
                ? `${routing.providers.length} ordered provider${routing.providers.length === 1 ? "" : "s"}`
                : routing
                  ? "Automatic routing"
                  : adminProviderAdapterLabel(model.draftConfig.adapterKind);
              return (
                <div
                  className={`flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between ${adminAvailabilityRowClass(model.enabled)}`}
                  data-resource-availability-row={model.enabled ? "enabled" : "disabled"}
                  key={model.id}
                  role="listitem"
                >
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium text-ink">{model.displayName}</p>
                    <p className="mt-1 text-xs leading-5 text-ink-muted">
                      {adminProviderAdapterLabel(model.draftConfig.adapterKind)} · {routingText} · {isEmbedding ? "Embedding model" : model.draftConfig.answerSelectable ? "Answer model" : "Technical runtime only"}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <AdminAvailabilityStatus enabled={model.enabled} />
                      <span className={
                        presentation.publication === "active"
                          ? "text-positive"
                          : presentation.publication === "pending"
                            ? "text-caution"
                            : "text-ink-muted"
                      }>
                        {presentation.publicationLabel}
                      </span>
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {!isEmbedding ? (
                      <button
                        aria-label={`Edit ${model.displayName}`}
                        className={quietButton}
                        disabled={controller.state.busy}
                        onClick={() => setEditingId(model.id)}
                        type="button"
                      >
                        <Pencil aria-hidden="true" className="size-3.5" />
                        Edit
                      </button>
                    ) : null}
                    <button
                      aria-label={`${model.enabled ? "Disable" : "Enable"} ${model.displayName} model`}
                      className={model.enabled ? quietButton : enableButton}
                      disabled={controller.state.busy}
                      onClick={() => void controller.actions.updateModel(
                        connection.id,
                        model.id,
                        { action: model.enabled ? "disable" : "enable" },
                        model.enabled
                          ? "Model disabled for new runs."
                          : "Model enabled; activation will validate its catalog presence."
                      )}
                      type="button"
                    >
                      {model.enabled ? "Disable" : "Enable"}
                    </button>
                    <details className="relative">
                      <summary
                        aria-label={`More actions for ${model.displayName} model`}
                        className={`${quietButton} cursor-pointer list-none`}
                      >
                        <MoreHorizontal aria-hidden="true" className="size-3.5" />
                        More
                      </summary>
                      <div className="absolute right-0 top-full z-20 mt-1 grid min-w-52 gap-1 rounded-panel border border-trace-subtle bg-overlay-surface p-2 shadow-overlay">
                        <button
                          aria-label={`Delete ${model.displayName} model`}
                          className={dangerButton}
                          disabled={controller.state.busy}
                          onClick={() => requestConfirmation({
                            body: "The deployment can be deleted only after Assistant revisions, grants, defaults, the system model role, Search references, and live run bindings are removed.",
                            confirmLabel: "Delete model",
                            dialogLabel: `Delete ${model.displayName} model`,
                            icon: "trash",
                            onConfirm: async () => {
                              await controller.actions.deleteModel(connection.id, model.id);
                            },
                            testId: "admin-confirm-delete-provider-model",
                            title: `Delete “${model.displayName}”?`,
                            tone: "destructive"
                          })}
                          type="button"
                        >
                          <Trash2 aria-hidden="true" className="size-3.5" />
                          Delete model
                        </button>
                      </div>
                    </details>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState detail="Add one explicitly configured model deployment." title="No models yet" />
        )}
      </div>
    </section>
  );
}
