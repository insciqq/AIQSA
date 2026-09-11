"use client";

import { AdminChatDefaultsCard } from "@/components/admin/roles/AdminChatDefaultsCard";
import { AdminSystemRolesTable } from "@/components/admin/roles/AdminSystemRolesTable";
import { sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import { useAdminRolesController } from "@/components/admin/roles/useAdminRolesController";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminFeedbackController } from "@/components/admin/useAdminFeedback";
import { UiV2Button } from "@/components/ui-v2";
import type { AdminGroup } from "@/lib/contracts/admin";
import { useEffect, useRef } from "react";

export const ADMIN_ROLES_FOOTNOTE =
  "Only deployments that can do the job are listed. One that has not been checked for a role yet shows a Check action inside the picker; nothing else can be assigned. Personal Memory keeps each owner’s existing embedding space.";

/** Defaults & roles page (PRD 5.5): Chat defaults card over the System roles table. */
export function AdminRolesSection({
  groups,
  onMutationCommitted,
  reportError,
  reportNotice,
  requestConfirmation,
  resource = null
}: Readonly<{
  groups: readonly AdminGroup[];
  onMutationCommitted?(): void | Promise<unknown>;
  reportError: AdminFeedbackController["reportError"];
  reportNotice: AdminFeedbackController["reportNotice"];
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
  resource?: string | null;
}>) {
  const controller = useAdminRolesController({ onMutationCommitted, reportError, reportNotice });
  const focusedResource = useRef<string | null>(null);
  useEffect(() => {
    if (!resource) {
      focusedResource.current = null;
      return;
    }
    if (!controller.policy || focusedResource.current === resource) return;
    const id = ({ memory: "memory", chat_pdf: "chat-pdf", chat_titles: "chat-titles", reranker: "reranker" } as Record<string, string>)[resource];
    const row = id ? document.getElementById(`admin-role-${id}`) : null;
    if (row) {
      row.focus({ preventScroll: true });
      row.scrollIntoView?.({ block: "center" });
      focusedResource.current = resource;
    }
  }, [controller.policy, resource]);

  return (
    <div className="flex max-w-[1120px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <AdminChatDefaultsCard
        busy={controller.busy}
        catalog={controller.modelPolicy}
        error={controller.modelPolicyError}
        groups={groups}
        loading={controller.loading}
        onSave={controller.saveChatDefaults}
      />
      <section aria-labelledby="admin-system-roles-heading" className="grid gap-2.5">
        <h2 className={sectionHeadingClass} id="admin-system-roles-heading">System roles</h2>
        {controller.policy ? (
          <AdminSystemRolesTable controller={controller} requestConfirmation={requestConfirmation} />
        ) : controller.error ? (
          <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-critical/25 bg-critical/5 px-5 py-3" role="alert">
            <p className="text-sm text-ink">{controller.error}</p>
            <UiV2Button onClick={() => void controller.refresh()} tone="ghost">Try again</UiV2Button>
          </div>
        ) : (
          <p className="text-sm text-ink-muted" role="status">Loading system roles…</p>
        )}
        <p className="text-xs leading-5 text-ink-muted">{ADMIN_ROLES_FOOTNOTE}</p>
      </section>
    </div>
  );
}
