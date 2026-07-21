import type { AdminActionResult } from "@/components/admin/adminApi";
import type { AdminRunAction } from "@/components/admin/useAdminActionRunner";
import type { AdminActionRequest } from "@/lib/contracts/admin";
import { useCallback, useMemo, useRef, useState } from "react";

export type AdminConfirmationIcon = "trash" | "x";
export type AdminConfirmationTone = "destructive" | "warning";

export type AdminConfirmationConfig = Readonly<{
  body: string;
  confirmLabel: string;
  dialogLabel: string;
  icon?: AdminConfirmationIcon;
  onConfirm(): Promise<void> | void;
  testId: string;
  title: string;
  tone?: AdminConfirmationTone;
}>;

export type AdminConfirmationRequest = AdminConfirmationConfig;

export type AdminConfirmedActionRequest = Readonly<{
  body: AdminActionRequest;
  confirmLabel: string;
  dialogLabel: string;
  icon?: AdminConfirmationIcon;
  message: string;
  onSuccess?(): void;
  prompt: string;
  testId: string;
  title: string;
  tone?: AdminConfirmationTone;
}>;

export type UseAdminConfirmationControllerOptions = Readonly<{
  runAction: AdminRunAction;
}>;

export type AdminConfirmationController = Readonly<{
  cancelConfirmation(): void;
  confirmation: AdminConfirmationConfig | null;
  confirmConfirmation(): void;
  requestConfirmation(config: AdminConfirmationRequest): void;
  requestConfirmedAction(config: AdminConfirmedActionRequest): void;
}>;

export function useAdminConfirmationController({
  runAction
}: UseAdminConfirmationControllerOptions): AdminConfirmationController {
  const [confirmation, setConfirmation] = useState<AdminConfirmationConfig | null>(null);
  const confirmationRef = useRef<AdminConfirmationConfig | null>(null);

  const requestConfirmation = useCallback((config: AdminConfirmationRequest) => {
    confirmationRef.current = config;
    setConfirmation(config);
  }, []);

  const cancelConfirmation = useCallback(() => {
    confirmationRef.current = null;
    setConfirmation(null);
  }, []);

  const confirmConfirmation = useCallback(() => {
    const action = confirmationRef.current?.onConfirm;
    if (!action) {
      return;
    }

    confirmationRef.current = null;
    setConfirmation(null);
    void action();
  }, []);

  const requestConfirmedAction = useCallback(
    (config: AdminConfirmedActionRequest) => {
      requestConfirmation({
        body: config.prompt,
        confirmLabel: config.confirmLabel,
        dialogLabel: config.dialogLabel,
        icon: config.icon,
        onConfirm: async () => {
          const result: AdminActionResult = await runAction(config.body, config.message);

          if (!result.error) {
            config.onSuccess?.();
          }
        },
        testId: config.testId,
        title: config.title,
        tone: config.tone
      });
    },
    [requestConfirmation, runAction]
  );

  return useMemo(
    () => ({
      cancelConfirmation,
      confirmation,
      confirmConfirmation,
      requestConfirmation,
      requestConfirmedAction
    }),
    [cancelConfirmation, confirmation, confirmConfirmation, requestConfirmation, requestConfirmedAction]
  );
}
