import { ConnectShell } from "@/features/connect/ConnectShell";
import { getAuthConfig } from "@/lib/server/auth/config";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { loadChatViewer } from "../(chat)/viewer";

export const metadata: Metadata = {
  title: "AIQSA Connect"
};

/** The canonical installation origin the install commands name, as `/agents/metadata` reports it. */
function installOrigin(): string | null {
  try {
    const base = new URL(getAuthConfig().appBaseUrl);
    if (base.username || base.password || base.hash || base.search) return null;
    return base.protocol === "https:" || base.protocol === "http:" ? base.origin : null;
  } catch {
    return null;
  }
}

/**
 * Every `/connect` page shares this shell, so the live computer list survives
 * moving between them. Without a viewer only the page renders, and it signs
 * in again with its own address; with the feature off the mode does not exist.
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
      installOrigin={installOrigin()}
    >
      {children}
    </ConnectShell>
  );
}
