"use client";

import { AdminTopbarMenu } from "@/components/admin/AdminShell";
import { AdminKnowledgeProcessingRows } from "@/components/admin/roles/AdminKnowledgeProcessingRows";
import { AdminRolePicker } from "@/components/admin/roles/AdminRolePicker";
import { AdminReasoningSelect as ReasoningSelect } from "@/components/admin/roles/AdminReasoningSelect";
import { AdminStatusPill } from "@/components/admin/roles/AdminStatusPill";
import { cardClass, compactSelectClass } from "@/components/admin/roles/rolesControls";
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
  statusLabel,
  testId,
  title
}: Readonly<{
  children: ReactNode;
  description: string;
  menu: readonly UiV2MenuAction[];
  status: AdminRoleStatus;
  statusLabel?: string;
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
        <AdminStatusPill label={statusLabel ?? ADMIN_ROLE_STATUS_LABEL[status]} status={status} testId={`${testId}-status`} />
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
  const pdfMode = policy.chatPdfProcessingMode ?? "prefer_chat_model";
  const pdfFallback = policy.chatPdfFallbackMethod ?? "page_images";
  const pdfUsesNativeReader = pdfMode === "use_pdf_reader" || pdfMode === "prefer_chat_model" && pdfFallback === "pdf_reader";
  const pdfReader = (pdfUsesNativeReader ? policy.chatPdfNativeModel : policy.chatPdfModel) ?? null;
  const pdfReaderName = pdfUsesNativeReader ? "PDF reader" : "Page-image reader";
  const pdfReaderReasoning = (pdfUsesNativeReader ? policy.chatPdfNativeReasoningEffort : policy.chatPdfReasoningEffort) ?? null;
  const pdfReaderSelection = (providerModelId: string | null, reasoningEffort: string | null) => pdfUsesNativeReader
    ? { chatPdfNativeProviderModelId: providerModelId, chatPdfNativeReasoningEffort: reasoningEffort }
    : { chatPdfProviderModelId: providerModelId, chatPdfReasoningEffort: reasoningEffort };
  const pdfReaderUndo = pdfReaderSelection(pdfReader?.id ?? null, pdfReaderReasoning);
  const pdfStatus = roleStatus(pdfReader);
  const pdfStatusLabel = pdfMode === "prefer_chat_model"
    ? { working: "Fallback ready", unavailable: "Fallback unavailable", not_assigned: "Fallback not set" }[pdfStatus]
    : { working: "Ready", unavailable: "Unavailable", not_assigned: "Not assigned" }[pdfStatus];
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
        title="PDF processing in chats"
        testId="admin-role-chat-pdf"
        menu={[{
          disabled: !pdfReader || busy,
          label: "Clear reader assignment",
          onSelect: () => void controller.assign(pdfReaderSelection(null, null), pdfReaderUndo)
        }]}
        status={pdfStatus}
        statusLabel={pdfStatusLabel}
        description="Choose how PDFs are read. Changes apply to future messages."
      >
        <label className="grid gap-1.5 text-xs text-ink-muted">
          <span>Processing mode</span>
          <select
            className={compactSelectClass}
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
            className={compactSelectClass}
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
        <div className="mt-2 grid gap-1.5">
          <p className="text-xs text-ink-muted">{pdfReaderName} model</p>
          <AdminRolePicker
            key={pdfReaderName}
            busy={busy}
            checkingId={checkingId}
            items={generativeRoleItems(catalog, pdfUsesNativeReader ? "direct_pdf" : "vision")}
            label={`${pdfReaderName} deployment`}
            onCheck={(id) => controller.checkAndAssign(pdfUsesNativeReader ? "direct_pdf" : "vision", id)}
            onSelect={(id) => void controller.assign(pdfReaderSelection(id, null), pdfReaderUndo)}
            roleName={pdfReaderName}
            selectedId={pdfReader?.id ?? null}
            selectedLabel={pdfReader ? label(pdfReader) : null}
            testId={pdfUsesNativeReader ? "admin-chat-pdf-native-picker" : "admin-chat-pdf-picker"}
          />
          <p className="text-xs leading-5 text-ink-muted">
            {pdfMode === "prefer_chat_model"
              ? "Used only when the chat model cannot read PDFs directly."
              : "Reads the document before your selected chat model answers."}
          </p>
        </div>
        <details>
          <summary className="cursor-pointer text-xs text-ink-muted outline-none focus-visible:ring-2 focus-visible:ring-focus">Advanced</summary>
          <div className="pt-2">
            <ReasoningSelect
              disabled={busy}
              label={`${pdfReaderName} reasoning`}
              model={pdfReader}
              onChange={(effort) => void controller.assign(pdfReaderSelection(pdfReader?.id ?? null, effort), pdfReaderUndo)}
              value={pdfReaderReasoning}
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
