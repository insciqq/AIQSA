import { useCallback, useMemo, useState } from "react";

export type AdminFeedbackState = Readonly<{
  error: string | null;
  notice: string | null;
}>;

export type AdminFeedbackController = AdminFeedbackState &
  Readonly<{
    clearAll(): void;
    clearError(): void;
    clearErrorIf(message: string): void;
    reportError(message: string): void;
    reportNotice(message: string): void;
  }>;

export function useAdminFeedback(): AdminFeedbackController {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const clearAll = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);
  const clearError = useCallback(() => setError(null), []);
  const clearErrorIf = useCallback((message: string) => {
    setError((current) => (current === message ? null : current));
  }, []);
  const reportError = useCallback((message: string) => setError(message), []);
  const reportNotice = useCallback((message: string) => setNotice(message), []);

  return useMemo(
    () => ({
      clearAll,
      clearError,
      clearErrorIf,
      error,
      notice,
      reportError,
      reportNotice
    }),
    [clearAll, clearError, clearErrorIf, error, notice, reportError, reportNotice]
  );
}
