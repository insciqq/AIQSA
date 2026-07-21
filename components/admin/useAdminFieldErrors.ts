"use client";

import { adminActionErrorMessage } from "@/components/admin/adminApi";
import { useCallback, useMemo, useRef, useState } from "react";

export type AdminFieldErrorId = "group-name" | "invite-email" | "rename-selected-group" | "rule-value";

export type AdminFieldError = Readonly<{
  field: AdminFieldErrorId;
  message: string;
}>;

type AdminFieldErrorFeedback = Readonly<{
  clearErrorIf(message: string): void;
  reportError(message: string): void;
}>;

export type AdminFieldErrorController = Readonly<{
  clearFieldError(field: AdminFieldErrorId): void;
  fieldError: AdminFieldError | null;
  reportFieldError(field: AdminFieldErrorId, code: string): void;
}>;

function scheduleFieldFocus(field: AdminFieldErrorId) {
  const focus = () => document.getElementById(field)?.focus();

  if (window.requestAnimationFrame) {
    window.requestAnimationFrame(focus);
    return;
  }

  window.setTimeout(focus, 0);
}

export function useAdminFieldErrors(feedback: AdminFieldErrorFeedback): AdminFieldErrorController {
  const { clearErrorIf, reportError } = feedback;
  const [fieldError, setFieldError] = useState<AdminFieldError | null>(null);
  const fieldErrorRef = useRef<AdminFieldError | null>(null);

  const reportFieldError = useCallback(
    (field: AdminFieldErrorId, code: string) => {
      const message = adminActionErrorMessage(code);
      reportError(message);
      const nextError = { field, message };
      fieldErrorRef.current = nextError;
      setFieldError(nextError);
      scheduleFieldFocus(field);
    },
    [reportError]
  );

  const clearFieldError = useCallback(
    (field: AdminFieldErrorId) => {
      const current = fieldErrorRef.current;
      if (current?.field !== field) {
        return;
      }

      fieldErrorRef.current = null;
      clearErrorIf(current.message);
      setFieldError(null);
    },
    [clearErrorIf]
  );

  return useMemo(
    () => ({
      clearFieldError,
      fieldError,
      reportFieldError
    }),
    [clearFieldError, fieldError, reportFieldError]
  );
}
