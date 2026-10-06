"use client";

import { AppErrorScreen } from "@/components/errors/AppErrorScreen";

export default function AppError({
  error,
  reset,
  retry
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
  retry?: () => void;
}>) {
  return <AppErrorScreen error={error} reset={reset} retry={retry} />;
}
