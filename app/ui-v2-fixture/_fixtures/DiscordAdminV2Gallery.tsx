"use client";

import { AdminConfirmationHost } from "@/components/admin/AdminConfirmationHost";
import { AdminDiscordSection } from "@/components/admin/discord/AdminDiscordSection";
import { useAdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import { useEffect, useState } from "react";
import { installDiscordFixtureApi, type DiscordAdminFixtureScenario } from "./discordFixtureApi";

const feedback = { reportError: () => undefined, reportNotice: () => undefined };
const navigate = () => undefined;
const noAction = async () => ({ error: "fixture_only" });

/** Control Center → Discord, answering from the fixture API. */
export function DiscordAdminV2Gallery({ state }: Readonly<{ state: DiscordAdminFixtureScenario }>) {
  const [ready, setReady] = useState(false);
  const confirmation = useAdminConfirmationController({ runAction: noAction });
  useEffect(() => {
    const restore = installDiscordFixtureApi(state);
    const frame = window.requestAnimationFrame(() => setReady(true));
    return () => {
      window.cancelAnimationFrame(frame);
      restore();
    };
  }, [state]);
  if (!ready) return null;
  return (
    <main className="min-h-[100dvh] overflow-x-clip bg-app-canvas text-ink" data-testid="discord-admin-fixture">
      <AdminDiscordSection feedback={feedback} onNavigateSection={navigate} requestConfirmation={confirmation.requestConfirmation} />
      <AdminConfirmationHost controller={confirmation} onClosed={() => undefined} />
    </main>
  );
}
