"use client";

import { AdminKnowledgeHealthCard } from "@/components/admin/retrieval/AdminKnowledgeHealthCard";
import { AdminMemoryHealthCard } from "@/components/admin/retrieval/AdminMemoryHealthCard";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminFeedbackController } from "@/components/admin/useAdminFeedback";
import { KNOWLEDGE_ENABLED } from "@/lib/domain/disabledAreas";

/** Knowledge & Memory page (PRD 5.7): two health cards, assignments linked out. */
export function AdminRetrievalSection({
  onMutationCommitted,
  onOpenRoles,
  reportNotice,
  requestConfirmation
}: Readonly<{
  onMutationCommitted?(): void | Promise<unknown>;
  onOpenRoles(): void;
  reportNotice: AdminFeedbackController["reportNotice"];
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
}>) {
  return (
    <div className="flex max-w-[1120px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* Knowledge is disabled: the page keeps only Memory. */}
      {KNOWLEDGE_ENABLED ? (
        <AdminKnowledgeHealthCard
          onMutationCommitted={onMutationCommitted}
          onOpenRoles={onOpenRoles}
          reportNotice={reportNotice}
        />
      ) : null}
      <AdminMemoryHealthCard reportNotice={reportNotice} requestConfirmation={requestConfirmation} />
    </div>
  );
}
