import { isTestAuthEnabled } from "@/lib/server/auth/config";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

export default function UiV2FixtureLayout({
  children
}: Readonly<{ children: ReactNode }>) {
  if (!isTestAuthEnabled()) notFound();
  return children;
}
