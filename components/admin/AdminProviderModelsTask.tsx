"use client";

import {
  AdminProviderModelEditor,
  adminProviderAdapterLabel
} from "@/components/admin/AdminProviderModelEditor";
import {
  EmptyState,
  dangerButton,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import { presentProviderModel } from "@/components/admin/providerAdvancedView";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminOpenRouterDiscoverySession } from "@/components/admin/useAdminOpenRouterDiscovery";
import type { AdminProvidersController } from "@/components/admin/useAdminProvidersController";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";
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
              const routing = model.draftConfig.openRouterRouting;
              const routingText = routing?.mode === "only_selected"
                ? `${routing.providers.length} ordered provider${routing.providers.length === 1 ? "" : "s"}`
                : routing
                  ? "Automatic routing"
                  : adminProviderAdapterLabel(model.draftConfig.adapterKind);
              return (
                <div
                  className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
                  key={model.id}
                  role="listitem"
                >
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium text-ink">{model.displayName}</p>
                    <p className="mt-1 text-xs leading-5 text-ink-muted">
                      {adminProviderAdapterLabel(model.draftConfig.adapterKind)} · {routingText}
                    </p>
                    <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                      <span className={model.enabled ? "text-positive" : "text-ink-muted"}>
                        {presentation.runtimeLabel}
                      </span>
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
                    <button
                      aria-label={`${model.enabled ? "Disable" : "Enable"} ${model.displayName} model`}
                      className={quietButton}
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
                            body: "The deployment can be deleted only after profiles, grants, defaults, search references, and live run bindings are removed.",
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
