import { PowerAppShellV2 } from "@/features/workspace-v2/PowerAppShellV2";
import { AIQSA_TIME_ZONE_COOKIE_NAME, greetingPeriodInTimeZone } from "@/lib/domain/greeting";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { loadChatViewer } from "./viewer";

export const metadata: Metadata = {
  title: "Chat"
};

/**
 * Every chat address shares this layout, so moving between `/` and `/c/<id>`
 * keeps one mounted shell; the shell reads the address
 * itself. Without a viewer only the page renders, and it redirects to sign-in.
 */
export default async function ChatLayout({ children }: Readonly<{ children: ReactNode }>) {
  const viewer = await loadChatViewer();
  if (!viewer) return children;
  const timeZone = (await cookies()).get(AIQSA_TIME_ZONE_COOKIE_NAME)?.value;
  return (
    <>
      <PowerAppShellV2
        accountDisplayName={viewer.accountDisplayName}
        accountEmail={viewer.accountEmail}
        accountId={viewer.accountId}
        adminEntryVisible={viewer.adminEntryVisible}
        connectEntryVisible={viewer.connectEnabled}
        greetingPeriod={greetingPeriodInTimeZone(timeZone, new Date())}
        telegramAvailable={viewer.telegramAvailable}
      />
      {children}
    </>
  );
}
