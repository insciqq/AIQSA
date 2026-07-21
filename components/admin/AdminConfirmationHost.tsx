import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";

export function AdminConfirmationHost({
  controller,
  onClosed
}: Readonly<{
  controller: Pick<AdminConfirmationController, "cancelConfirmation" | "confirmation" | "confirmConfirmation">;
  onClosed(): void;
}>) {
  const confirmation = controller.confirmation;

  if (!confirmation) {
    return null;
  }

  return (
    <ConfirmationDialog
      confirmLabel={confirmation.confirmLabel}
      dialogLabel={confirmation.dialogLabel}
      icon={confirmation.icon}
      onCancel={() => {
        controller.cancelConfirmation();
        onClosed();
      }}
      onConfirm={() => {
        controller.confirmConfirmation();
        onClosed();
      }}
      testId={confirmation.testId}
      title={confirmation.title}
      tone={confirmation.tone}
    >
      {confirmation.body}
    </ConfirmationDialog>
  );
}
