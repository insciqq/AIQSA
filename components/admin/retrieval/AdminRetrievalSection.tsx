"use client";

import { AdminMemoryHealthCard } from "@/components/admin/retrieval/AdminMemoryHealthCard";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminFeedbackController } from "@/components/admin/useAdminFeedback";

/** Memory page (PRD 5.7): the Memory health card, assignments linked out. */
export function AdminRetrievalSection({
  reportNotice,
  requestConfirmation
}: Readonly<{
  reportNotice: AdminFeedbackController["reportNotice"];
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
}>) {
  return (
    <div className="flex max-w-[1120px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <AdminMemoryHealthCard reportNotice={reportNotice} requestConfirmation={requestConfirmation} />
    </div>
  );
}
