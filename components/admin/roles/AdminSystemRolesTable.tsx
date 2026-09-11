"use client";

import { AdminTopbarMenu } from "@/components/admin/AdminShell";
import { AdminKnowledgeProcessingRows } from "@/components/admin/roles/AdminKnowledgeProcessingRows";
import { AdminRolePicker } from "@/components/admin/roles/AdminRolePicker";
import { AdminReasoningSelect as ReasoningSelect } from "@/components/admin/roles/AdminReasoningSelect";
import { AdminStatusPill } from "@/components/admin/roles/AdminStatusPill";
import { cardClass } from "@/components/admin/roles/rolesControls";
import {
  ADMIN_ROLE_STATUS_LABEL,
  deploymentLabeller,
  generativeRoleItems,
  rerankerFallbacksLine,
  rerankerItems,
  roleStatus,
  type AdminRoleStatus
} from "@/components/admin/roles/rolesView";
import type { AdminRolesController } from "@/components/admin/roles/useAdminRolesController";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import { UiV2Button, type UiV2MenuAction } from "@/components/ui-v2";
import { useState, type ReactNode } from "react";
import { ImageParameterFields } from "@/components/admin/providers/models/ImageParameterFields";
import { initialChatTitleReasoningEffort, type AdminImageModelCandidate } from "@/lib/contracts/adminSystemModelPolicy";
import type { ImageGenerationParameters } from "@/lib/contracts/imageGeneration";

const rowGrid = "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-3 px-4 py-3 xl:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)_8.5rem_2.5rem] xl:items-start xl:gap-4";

function ImageRoleParameters({ model, parameters, busy, save }: {
  model: AdminImageModelCandidate; parameters: ImageGenerationParameters; busy: boolean;
  save(parameters: ImageGenerationParameters): void;
}) {
  const [draft, setDraft] = useState(parameters);
  return <details>
    <summary className="cursor-pointer text-xs text-ink-muted outline-none focus-visible:ring-2 focus-visible:ring-focus">Image settings</summary>
    <div className="flex flex-col gap-3 pt-3">
      <ImageParameterFields image={model.image} modelId={model.upstreamModelId} parameters={draft} onChange={setDraft} disabled={busy} defaultLabel="Model default" />
      <UiV2Button disabled={busy || JSON.stringify(draft) === JSON.stringify(parameters)} onClick={() => save(draft)} type="button">Apply image settings</UiV2Button>
    </div>
  </details>;
}

function RoleRow({
  children,
  description,
  menu,
  status,
  testId,
  title
}: Readonly<{
  children: ReactNode;
  description: string;
  menu: readonly UiV2MenuAction[];
  status: AdminRoleStatus;
  testId: string;
  title: string;
}>) {
  return (
    <div className={`${rowGrid} border-t border-trace-subtle first:border-t-0`} data-testid={testId} id={testId} tabIndex={-1}>
      <div className="order-1 min-w-0">
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="mt-0.5 text-xs leading-5 text-ink-muted">{description}</p>
      </div>
      <div className="order-2 xl:order-4 xl:justify-self-end">
        {menu.length ? <AdminTopbarMenu actions={menu} label={`${title} actions`} /> : null}
      </div>
      <div className="order-3 col-span-2 grid gap-1.5 xl:order-2 xl:col-span-1">{children}</div>
      <div className="order-4 col-span-2 xl:order-3 xl:col-span-1 xl:pt-1.5">
        <AdminStatusPill label={ADMIN_ROLE_STATUS_LABEL[status]} status={status} testId={`${testId}-status`} />
      </div>
    </div>
  );
}

/**
 * System roles: independent assignments apply on selection with Undo; the Knowledge processing group needs Apply.
 */
export function AdminSystemRolesTable({
  controller,
  requestConfirmation
}: Readonly<{
  controller: AdminRolesController;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
}>) {
  const catalog = controller.policy;
  if (!catalog) return null;
  const policy = catalog.policy;
  const label = deploymentLabeller(catalog);
  const busy = controller.busy || controller.checking !== null;
  const checkingId = controller.checking?.id ?? null;
  const memoryUndo = {
    providerModelId: policy.systemModel?.id ?? null,
    reasoningEffort: policy.reasoningEffort
  };
  const titleUndo = {
    chatTitleProviderModelId: policy.chatTitleModel?.id ?? null,
    chatTitleReasoningEffort: policy.chatTitleReasoningEffort
  };
  const pdfUndo = {
    chatPdfProviderModelId: policy.chatPdfModel?.id ?? null,
    chatPdfReasoningEffort: policy.chatPdfReasoningEffort
  };
  const pdfNativeUndo = {
    chatPdfNativeProviderModelId: policy.chatPdfNativeModel?.id ?? null,
    chatPdfNativeReasoningEffort: policy.chatPdfNativeReasoningEffort ?? null
  };
  const pdfMode = policy.chatPdfProcessingMode ?? "prefer_chat_model";
  const pdfFallback = policy.chatPdfFallbackMethod ?? "page_images";
  const rerankerUndo = { rerankerProviderModelId: policy.rerankerModel?.id ?? null };
  const imageUndo = { imageProviderModelId: policy.imageModel?.id ?? null, imageParameters: policy.imageParameters ?? {} };
  const fallbacks = rerankerFallbacksLine(catalog);

  return (
    <div className={cardClass} data-testid="admin-system-roles">
      <div className="hidden border-b border-trace-subtle px-4 py-2 text-metadata font-semibold uppercase tracking-[0.08em] text-ink-muted xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)_8.5rem_2.5rem] xl:gap-4">
        <span>Role</span>
        <span>Deployment</span>
        <span>Status</span>
        <span />
      </div>

      <RoleRow
        description="Handles Memory, MCP routing and structured helpers. Needs strict JSON output and forced tool calls."
        menu={[{
          disabled: !policy.systemModel || busy,
          label: "Clear assignment",
          onSelect: () => void controller.assign({ providerModelId: null, reasoningEffort: null }, memoryUndo)
        }]}
        status={roleStatus(policy.systemModel)}
        testId="admin-role-memory"
        title="System model"
      >
        <AdminRolePicker
          busy={busy}
          checkingId={checkingId}
          items={generativeRoleItems(catalog, "memory")}
          label="System model deployment"
          onCheck={(id) => controller.checkAndAssign("memory", id)}
          onSelect={(id) => void controller.assign({ providerModelId: id, reasoningEffort: null }, memoryUndo)}
          roleName="System model"
          selectedId={policy.systemModel?.id ?? null}
          selectedLabel={policy.systemModel ? label(policy.systemModel) : null}
          testId="admin-memory-picker"
        />
        <details>
          <summary className="cursor-pointer text-xs text-ink-muted outline-none focus-visible:ring-2 focus-visible:ring-focus">Advanced</summary>
          <div className="pt-2">
            <ReasoningSelect
              disabled={busy}
              label="System model reasoning"
              model={policy.systemModel}
              onChange={(effort) => void controller.assign(
                { providerModelId: policy.systemModel?.id ?? null, reasoningEffort: effort },
                memoryUndo
              )}
              value={policy.reasoningEffort}
            />
          </div>
        </details>
      </RoleRow>

      <RoleRow
        description="Names new chats after the first answer. Needs strict JSON output. When unassigned, uses the first message."
        menu={[{
          disabled: !policy.chatTitleModel || busy,
          label: "Clear assignment",
          onSelect: () => void controller.assign({ chatTitleProviderModelId: null, chatTitleReasoningEffort: null }, titleUndo)
        }]}
        status={roleStatus(policy.chatTitleModel)}
        testId="admin-role-chat-titles"
        title="Chat titles"
      >
        <AdminRolePicker
          busy={busy}
          checkingId={checkingId}
          items={generativeRoleItems(catalog, "chat_titles")}
          label="Chat titles deployment"
          onCheck={(id) => controller.checkAndAssign("chat_titles", id)}
          onSelect={(id) => void controller.assign({
            chatTitleProviderModelId: id,
            chatTitleReasoningEffort: initialChatTitleReasoningEffort(catalog.titleCandidates.find((candidate) => candidate.id === id))
          }, titleUndo)}
          roleName="Chat titles"
          selectedId={policy.chatTitleModel?.id ?? null}
          selectedLabel={policy.chatTitleModel ? label(policy.chatTitleModel) : null}
          testId="admin-chat-titles-picker"
        />
        <details>
          <summary className="cursor-pointer text-xs text-ink-muted outline-none focus-visible:ring-2 focus-visible:ring-focus">Advanced</summary>
          <div className="pt-2">
            <ReasoningSelect
              disabled={busy}
              label="Chat titles reasoning"
              model={policy.chatTitleModel}
              onChange={(effort) => void controller.assign({
                chatTitleProviderModelId: policy.chatTitleModel?.id ?? null, chatTitleReasoningEffort: effort
              }, titleUndo)}
              value={policy.chatTitleReasoningEffort}
            />
          </div>
        </details>
      </RoleRow>

      <RoleRow
        title="PDF processing in chats" testId="admin-role-chat-pdf" menu={[]}
        status={roleStatus((pdfMode === "use_pdf_reader" || pdfMode === "prefer_chat_model" && pdfFallback === "pdf_reader"
          ? policy.chatPdfNativeModel : policy.chatPdfModel) ?? null)}
        description="Prefer chat model sends PDFs directly when supported; otherwise it uses the selected fallback. Reader modes prepare the document before your selected chat model answers."
      >
        <label className="grid gap-1.5 text-xs text-ink-muted">
          <span>Processing mode</span>
          <select
            className="v2-input"
            disabled={busy}
            value={pdfMode}
            onChange={(event) => void controller.assign(
              { chatPdfProcessingMode: event.target.value as typeof pdfMode },
              { chatPdfProcessingMode: pdfMode, chatPdfFallbackMethod: pdfFallback }
            )}
          >
            <option value="prefer_chat_model">Prefer chat model</option>
            <option value="use_pdf_reader">Use PDF reader</option>
            <option value="read_page_images">Read page images</option>
          </select>
        </label>
        {pdfMode === "prefer_chat_model" ? <label className="grid gap-1.5 text-xs text-ink-muted">
          <span>Fallback method</span>
          <select
            className="v2-input"
            disabled={busy}
            value={pdfFallback}
            onChange={(event) => void controller.assign(
              { chatPdfFallbackMethod: event.target.value as typeof pdfFallback },
              { chatPdfProcessingMode: pdfMode, chatPdfFallbackMethod: pdfFallback }
            )}
          >
            <option value="pdf_reader">Use PDF reader</option>
            <option value="page_images">Read page images</option>
          </select>
        </label> : null}
        <p className="text-xs leading-5 text-ink-muted">Configure the chosen reader below. Changes apply to future messages.</p>
      </RoleRow>

      <RoleRow
        description="Prepares PDFs through native PDF input. Needs verified PDF support and the provider’s default key."
        menu={[{
          disabled: !policy.chatPdfNativeModel || busy,
          label: "Clear assignment",
          onSelect: () => void controller.assign(
            { chatPdfNativeProviderModelId: null, chatPdfNativeReasoningEffort: null },
            pdfNativeUndo
          )
        }]}
        status={roleStatus(policy.chatPdfNativeModel ?? null)}
        testId="admin-role-chat-pdf-native"
        title="PDF reader"
      >
        <AdminRolePicker
          busy={busy}
          checkingId={checkingId}
          items={generativeRoleItems(catalog, "direct_pdf")}
          label="PDF reader deployment"
          onCheck={(id) => controller.checkAndAssign("direct_pdf", id)}
          onSelect={(id) => void controller.assign(
            { chatPdfNativeProviderModelId: id, chatPdfNativeReasoningEffort: null },
            pdfNativeUndo
          )}
          roleName="PDF reader"
          selectedId={policy.chatPdfNativeModel?.id ?? null}
          selectedLabel={policy.chatPdfNativeModel ? label(policy.chatPdfNativeModel) : null}
          testId="admin-chat-pdf-native-picker"
        />
        <details>
          <summary className="cursor-pointer text-xs text-ink-muted outline-none focus-visible:ring-2 focus-visible:ring-focus">Advanced</summary>
          <div className="pt-2">
            <ReasoningSelect
              disabled={busy}
              label="PDF reader reasoning"
              model={policy.chatPdfNativeModel ?? null}
              onChange={(effort) => void controller.assign(
                { chatPdfNativeProviderModelId: policy.chatPdfNativeModel?.id ?? null, chatPdfNativeReasoningEffort: effort },
                pdfNativeUndo
              )}
              value={policy.chatPdfNativeReasoningEffort ?? null}
            />
          </div>
        </details>
      </RoleRow>

      <RoleRow
        description="Prepares PDFs from page images and native text. Needs verified image input and the provider’s default key."
        menu={[{
          disabled: !policy.chatPdfModel || busy,
          label: "Clear assignment",
          onSelect: () => void controller.assign(
            { chatPdfProviderModelId: null, chatPdfReasoningEffort: null },
            pdfUndo
          )
        }]}
        status={roleStatus(policy.chatPdfModel)}
        testId="admin-role-chat-pdf-images"
        title="Page-image reader"
      >
        <AdminRolePicker
          busy={busy}
          checkingId={checkingId}
          items={generativeRoleItems(catalog, "vision")}
          label="Page-image reader deployment"
          onCheck={(id) => controller.checkAndAssign("vision", id)}
          onSelect={(id) => void controller.assign(
            { chatPdfProviderModelId: id, chatPdfReasoningEffort: null },
            pdfUndo
          )}
          roleName="Page-image reader"
          selectedId={policy.chatPdfModel?.id ?? null}
          selectedLabel={policy.chatPdfModel ? label(policy.chatPdfModel) : null}
          testId="admin-chat-pdf-picker"
        />
        <details>
          <summary className="cursor-pointer text-xs text-ink-muted outline-none focus-visible:ring-2 focus-visible:ring-focus">Advanced</summary>
          <div className="pt-2">
            <ReasoningSelect
              disabled={busy}
              label="Page-image reader reasoning"
              model={policy.chatPdfModel}
              onChange={(effort) => void controller.assign(
                { chatPdfProviderModelId: policy.chatPdfModel?.id ?? null, chatPdfReasoningEffort: effort },
                pdfUndo
              )}
              value={policy.chatPdfReasoningEffort}
            />
          </div>
        </details>
      </RoleRow>

      <RoleRow
        description="Reorders Memory and Knowledge candidates. Dedicated reranker only."
        menu={[{
          disabled: !policy.rerankerModel || busy,
          label: "Clear assignment",
          onSelect: () => void controller.assign({ rerankerProviderModelId: null }, rerankerUndo)
        }]}
        status={roleStatus(policy.rerankerModel)}
        testId="admin-role-reranker"
        title="Reranking"
      >
        <AdminRolePicker
          busy={busy}
          items={rerankerItems(catalog)}
          label="Reranking deployment"
          onSelect={(id) => void controller.assign({ rerankerProviderModelId: id }, rerankerUndo)}
          roleName="Reranking"
          selectedId={policy.rerankerModel?.id ?? null}
          selectedLabel={policy.rerankerModel ? label(policy.rerankerModel) : null}
          testId="admin-reranker-picker"
        />
        {fallbacks ? <p className="text-xs leading-5 text-ink-muted" data-testid="admin-reranker-fallbacks">{fallbacks}</p> : null}
      </RoleRow>

      <RoleRow title="Image generation" testId="admin-role-image" status={roleStatus(policy.imageModel ?? null)}
        description="Creates and edits images when requested in chat. Uses this model and the provider's default key."
        menu={[{ disabled: !policy.imageModel || busy, label: "Clear assignment",
          onSelect: () => void controller.assign({ imageProviderModelId: null, imageParameters: {} }, imageUndo) }]}>
        <AdminRolePicker busy={busy} items={(catalog.imageCandidates ?? []).map((model) => ({ group: "ready", id: model.id, label: `${model.displayName} · ${model.connectionDisplayName}` }))}
          label="Image generation deployment" roleName="Image generation" testId="admin-image-picker"
          selectedId={policy.imageModel?.id ?? null} selectedLabel={policy.imageModel ? `${policy.imageModel.displayName} · ${policy.imageModel.connectionDisplayName}` : null}
          onSelect={(id) => void controller.assign({ imageProviderModelId: id, imageParameters: {} }, imageUndo)} />
        {policy.imageModel ? <>
          <p className="text-xs text-ink-muted">{[policy.imageModel.generation ? "Generation verified" : "Generation unavailable", policy.imageModel.editing ? "Editing verified" : "Editing unavailable"].join(" · ")}</p>
          <ImageRoleParameters key={`${policy.imageModel.id}:${policy.version}`} model={policy.imageModel} parameters={policy.imageParameters ?? {}} busy={busy}
            save={(parameters) => void controller.assign({ imageProviderModelId: policy.imageModel!.id, imageParameters: parameters }, imageUndo)} />
        </> : <p className="text-xs text-ink-muted">Add and test an image model in Providers to make it available here.</p>}
      </RoleRow>

      <AdminKnowledgeProcessingRows controller={controller} requestConfirmation={requestConfirmation} />
    </div>
  );
}
