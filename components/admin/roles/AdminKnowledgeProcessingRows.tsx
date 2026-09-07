"use client";

import { AdminSheet } from "@/components/admin/AdminSheet";
import { AdminTopbarMenu } from "@/components/admin/AdminShell";
import { AdminRolePicker } from "@/components/admin/roles/AdminRolePicker";
import { AdminStatusPill } from "@/components/admin/roles/AdminStatusPill";
import { compactSelectClass } from "@/components/admin/roles/rolesControls";
import {
  ADMIN_ROLE_STATUS_LABEL,
  KNOWLEDGE_MODE_LABEL,
  embeddingDestinationLabel,
  embeddingItems,
  knowledgeDestinationLabel,
  knowledgeDocumentItems,
  knowledgeProcessingState,
  knowledgeReindexDisclosure,
  type AdminRoleStatus,
  type KnowledgeModelMode
} from "@/components/admin/roles/rolesView";
import type { AdminKnowledgeDraft, AdminRolesController } from "@/components/admin/roles/useAdminRolesController";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import { UiV2Button } from "@/components/ui-v2";
import type {
  AdminKnowledgePdfProcessingMode,
  AdminKnowledgeProfileRevision,
  AdminKnowledgeProfileSettings
} from "@/lib/contracts/adminKnowledge";
import { useState } from "react";

function draftFor(profile: AdminKnowledgeProfileSettings | null): AdminKnowledgeDraft {
  const active = profile?.activeRevision ?? null;
  return {
    documentDeploymentId: active?.pdfProcessing.destination?.deploymentId ?? null,
    embeddingDeploymentId: active?.destination.deploymentId ?? "",
    mode: active?.pdfProcessing.mode ?? "local"
  };
}

function sameDraft(left: AdminKnowledgeDraft, right: AdminKnowledgeDraft): boolean {
  return left.mode === right.mode && left.embeddingDeploymentId === right.embeddingDeploymentId &&
    (left.mode === "local" || left.documentDeploymentId === right.documentDeploymentId);
}

function nestedStatus(profile: AdminKnowledgeProfileSettings): AdminRoleStatus {
  if (!profile.activeRevision || profile.health.state === "not_configured") return "not_assigned";
  return profile.health.state === "unavailable" ? "unavailable" : "working";
}

function revisionSummary(revision: AdminKnowledgeProfileRevision): string {
  const documents = revision.pdfProcessing.destination
    ? `${KNOWLEDGE_MODE_LABEL[revision.pdfProcessing.mode]} · ${knowledgeDestinationLabel(revision.pdfProcessing.destination)}`
    : KNOWLEDGE_MODE_LABEL.local;
  return `Embeddings: ${embeddingDestinationLabel(revision.destination)} · Documents: ${documents}`;
}

const dateFormat = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" });

/**
 * Knowledge processing group row with its Documents and Embeddings rows
 * (PRD 5.5 row 4). Documents and embeddings change together: edits stay a
 * draft until `Apply`, which confirms the reindexing disclosure first.
 */
export function AdminKnowledgeProcessingRows({
  controller,
  requestConfirmation
}: Readonly<{
  controller: AdminRolesController;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
}>) {
  const profile = controller.knowledge?.profile ?? null;
  const [syncedProfile, setSyncedProfile] = useState(profile);
  const [draft, setDraft] = useState<AdminKnowledgeDraft>(() => draftFor(profile));
  const [earlierOpen, setEarlierOpen] = useState(false);
  if (syncedProfile !== profile) {
    setSyncedProfile(profile);
    setDraft(draftFor(profile));
  }
  const busy = controller.busy || controller.checking !== null;

  if (!profile) {
    return (
      <div className="border-t border-trace-subtle bg-workspace-rail/40 px-4 py-3" data-testid="admin-role-knowledge">
        <p className="text-sm font-medium text-ink">Knowledge processing</p>
        <p className="mt-0.5 text-xs leading-5 text-ink-muted" role="status">
          {controller.knowledgeError ?? (controller.knowledgeLoading ? "Loading Knowledge processing…" : "Knowledge processing is unavailable.")}
        </p>
      </div>
    );
  }

  const current = draftFor(profile);
  const dirty = !sameDraft(draft, current);
  const state = knowledgeProcessingState(profile);
  const rowStatus = nestedStatus(profile);
  const modelMode: KnowledgeModelMode | null = draft.mode === "local" ? null : draft.mode;
  const documentItems = modelMode
    ? knowledgeDocumentItems(profile.availablePdfDestinations, modelMode, controller.policy)
    : [];
  const documentReady = documentItems.some((item) => item.group === "ready" && item.id === draft.documentDeploymentId);
  const activeDocument = profile.activeRevision?.pdfProcessing.destination ?? null;
  const embeddingReady = profile.availableDestinations.some((item) => item.deploymentId === draft.embeddingDeploymentId);
  const canApply = dirty && !busy && embeddingReady && (modelMode === null || documentReady);
  const earlier = profile.recentRevisions.filter((revision) =>
    revision.id !== profile.activeRevision?.id && revision.executionAuthority === "installation");

  const confirmAndRun = (
    mode: AdminKnowledgePdfProcessingMode,
    title: string,
    confirmLabel: string,
    testId: string,
    run: () => Promise<boolean>
  ) => {
    requestConfirmation({
      body: knowledgeReindexDisclosure(mode),
      confirmLabel,
      dialogLabel: title,
      icon: "x",
      onConfirm: () => void run(),
      testId,
      title,
      tone: "warning"
    });
  };

  return (
    <>
      <div
        className="flex flex-wrap items-center gap-3 border-t border-trace-subtle bg-workspace-rail/40 px-4 py-3"
        data-testid="admin-role-knowledge"
      >
        <div className="min-w-0 flex-1 basis-[16rem]">
          <p className="text-sm font-medium text-ink">Knowledge processing</p>
          <p className="mt-0.5 text-xs leading-5 text-ink-muted">
            Documents and embeddings change together. Changing either reprocesses all documents — you confirm before it starts.
          </p>
        </div>
        {dirty ? (
          <div className="flex items-center gap-2">
            <UiV2Button disabled={busy} onClick={() => setDraft(current)} tone="ghost">Discard</UiV2Button>
            <UiV2Button
              busy={controller.busy}
              disabled={!canApply}
              onClick={() => confirmAndRun(
                draft.mode,
                "Reprocess all Knowledge documents?",
                "Apply",
                "admin-knowledge-apply-confirmation",
                () => controller.applyKnowledge(draft)
              )}
              tone="primary"
            >
              Apply
            </UiV2Button>
          </div>
        ) : null}
        <AdminStatusPill label={state.label} status={state.status} testId="admin-knowledge-state" />
        <AdminTopbarMenu
          actions={[{
            disabled: earlier.length === 0 || busy,
            icon: "history",
            label: "Earlier configurations",
            onSelect: () => setEarlierOpen(true)
          }]}
          label="Knowledge processing actions"
        />
        {profile.health.code === "knowledge_profile_legacy_authority" ? (
          <p className="basis-full text-xs leading-5 text-caution" role="status">
            Some existing bases still process with their owners&apos; keys. Apply a configuration to move future work to the provider&apos;s default key; nothing already indexed changes.
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-3 border-t border-trace-subtle px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)_8.5rem_2.5rem] md:gap-4 md:pl-9" data-testid="admin-role-documents">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">Documents</p>
          <p className="mt-0.5 text-xs leading-5 text-ink-muted">How PDFs become text</p>
        </div>
        <div className="col-span-2 grid gap-1.5 md:col-span-1">
          <select
            aria-label="Documents mode"
            className={compactSelectClass}
            disabled={busy}
            onChange={(event) => {
              const mode = event.currentTarget.value as AdminKnowledgePdfProcessingMode;
              setDraft((previous) => ({
                ...previous,
                documentDeploymentId: mode === current.mode ? current.documentDeploymentId : null,
                mode
              }));
            }}
            value={draft.mode}
          >
            {(Object.keys(KNOWLEDGE_MODE_LABEL) as AdminKnowledgePdfProcessingMode[]).map((mode) => (
              <option key={mode} value={mode}>{KNOWLEDGE_MODE_LABEL[mode]}</option>
            ))}
          </select>
          {modelMode ? (
            <AdminRolePicker
              busy={busy}
              checkingId={controller.checking?.id ?? null}
              items={documentItems}
              label="Documents model"
              onCheck={async (id) => {
                const ready = await controller.checkDocument(modelMode, id);
                if (ready) setDraft((previous) => ({ ...previous, documentDeploymentId: id }));
                return ready;
              }}
              onSelect={(id) => setDraft((previous) => ({ ...previous, documentDeploymentId: id }))}
              placeholder="Choose a model"
              roleName="Documents"
              selectedId={draft.documentDeploymentId}
              selectedLabel={activeDocument && activeDocument.deploymentId === draft.documentDeploymentId
                ? `${knowledgeDestinationLabel(activeDocument)} (unavailable)`
                : null}
              testId="admin-documents-picker"
            />
          ) : null}
        </div>
        <div className="col-span-2 md:col-span-1">
          <AdminStatusPill label={ADMIN_ROLE_STATUS_LABEL[rowStatus]} status={rowStatus} />
        </div>
        <span aria-hidden="true" className="hidden md:block" />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-3 border-t border-trace-subtle px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)_8.5rem_2.5rem] md:gap-4 md:pl-9" data-testid="admin-role-embeddings">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">Embeddings</p>
          <p className="mt-0.5 text-xs leading-5 text-ink-muted">Vector space for Knowledge search</p>
        </div>
        <div className="col-span-2 md:col-span-1">
          <AdminRolePicker
            busy={busy}
            items={embeddingItems(profile.availableDestinations)}
            label="Embeddings model"
            onSelect={(id) => setDraft((previous) => ({ ...previous, embeddingDeploymentId: id }))}
            placeholder="Choose an embedding model"
            roleName="Embeddings"
            selectedId={draft.embeddingDeploymentId || null}
            selectedLabel={profile.activeRevision && profile.activeRevision.destination.deploymentId === draft.embeddingDeploymentId
              ? `${embeddingDestinationLabel(profile.activeRevision.destination)} (unavailable)`
              : null}
            testId="admin-embeddings-picker"
          />
        </div>
        <div className="col-span-2 md:col-span-1">
          <AdminStatusPill label={ADMIN_ROLE_STATUS_LABEL[rowStatus]} status={rowStatus} />
        </div>
        <span aria-hidden="true" className="hidden md:block" />
      </div>

      <AdminSheet
        closeBlocked={controller.busy}
        description="Restoring reprocesses every document with that configuration. You confirm before it starts."
        onClose={() => setEarlierOpen(false)}
        open={earlierOpen}
        testId="admin-earlier-configurations"
        title="Earlier configurations"
      >
        {earlier.length === 0 ? (
          <p className="text-sm text-ink-muted" role="status">No earlier configurations yet.</p>
        ) : (
          <ul aria-label="Earlier configurations" className="divide-y divide-trace-subtle">
            {earlier.map((revision) => (
              <li className="flex flex-wrap items-center gap-3 py-3" key={revision.id}>
                <div className="min-w-0 flex-1 basis-[14rem]">
                  <p className="break-words text-sm text-ink [overflow-wrap:anywhere]">{revisionSummary(revision)}</p>
                  <p className="mt-0.5 text-xs text-ink-muted">Applied {dateFormat.format(new Date(revision.activatedAt))}</p>
                </div>
                <UiV2Button
                  aria-label={`Restore configuration applied ${dateFormat.format(new Date(revision.activatedAt))}`}
                  disabled={busy}
                  onClick={() => confirmAndRun(
                    revision.pdfProcessing.mode,
                    "Restore this configuration?",
                    "Restore",
                    "admin-knowledge-restore-confirmation",
                    async () => {
                      const restored = await controller.restoreKnowledge(revision.id);
                      if (restored) setEarlierOpen(false);
                      return restored;
                    }
                  )}
                  tone="ghost"
                >
                  Restore
                </UiV2Button>
              </li>
            ))}
          </ul>
        )}
      </AdminSheet>
    </>
  );
}
