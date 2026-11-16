import { ConnectShell } from "@/features/connect/ConnectShell";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { loadChatViewer } from "../(chat)/viewer";

export const metadata: Metadata = {
  title: "AIQSA Connect"
};

/**
 * The pages under `/connect`: the pair page in its slim shell, and `/connect`
 * itself, which only redirects to Settings › Computers. Without a viewer only
 * the page renders, and it signs in again with its own address; with the
 * feature off neither exists.
 */
export default async function ConnectLayout({ children }: Readonly<{ children: ReactNode }>) {
  const viewer = await loadChatViewer();
  if (!viewer) return children;
  if (!viewer.connectEnabled) notFound();
  return (
    <ConnectShell
      accountId={viewer.accountId}
      accountLabel={viewer.accountDisplayName.trim() || viewer.accountEmail || "Account"}
      adminEntryVisible={viewer.adminEntryVisible}
    >
      {children}
    </ConnectShell>
  );
}
