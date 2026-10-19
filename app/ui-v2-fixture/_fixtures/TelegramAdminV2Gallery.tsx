"use client";

import { AdminTelegramSection } from "@/components/admin/telegram/AdminTelegramSection";
import { AdminUserTelegram } from "@/components/admin/telegram/AdminUserTelegram";
import type { AdminGroup } from "@/lib/contracts/admin";
import { useEffect, useState } from "react";
import { installTelegramFixtureApi, TELEGRAM_FIXTURE_GROUP_IDS, type TelegramAdminFixtureScenario } from "./telegramFixtureApi";

const groups: AdminGroup[] = [
  { accessGrants: [], archivedAt: null, id: TELEGRAM_FIXTURE_GROUP_IDS[0], name: "Research", systemRole: null, userCount: 12 },
  { accessGrants: [], archivedAt: null, id: TELEGRAM_FIXTURE_GROUP_IDS[1], name: "Customer support", systemRole: null, userCount: 31 }
];

const feedback = { reportError: () => undefined, reportNotice: () => undefined };

/** Control Center → Telegram and the Telegram panel of a user page, answering from the fixture API. */
export function TelegramAdminV2Gallery({ state }: Readonly<{ state: TelegramAdminFixtureScenario }>) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const restore = installTelegramFixtureApi({ admin: state });
    const frame = window.requestAnimationFrame(() => setReady(true));
    return () => {
      window.cancelAnimationFrame(frame);
      restore();
    };
  }, [state]);
  if (!ready) return null;
  return (
    <main className="min-h-[100dvh] overflow-x-clip bg-app-canvas text-ink" data-testid="telegram-admin-fixture">
      <AdminTelegramSection feedback={feedback} groups={groups} />
      <div className="max-w-[1120px] px-4 pb-10 sm:px-6 lg:px-8">
        <AdminUserTelegram userId="fixture-user" />
      </div>
    </main>
  );
}
