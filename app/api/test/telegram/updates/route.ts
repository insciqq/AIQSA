import { isTestModeAllowedEnv } from "@/lib/server/auth/csrf";
import { createTelegramTestUpdateHandler } from "@/lib/server/telegram/dispatcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Test mode only: feeds one Telegram update to the dispatcher as if polled; 404 otherwise. */
export const POST = createTelegramTestUpdateHandler({
  enabled: () => isTestModeAllowedEnv(process.env),
  async load() {
    const { getDefaultTelegram } = await import("@/lib/server/telegram/defaultTelegram");
    const telegram = getDefaultTelegram();
    return { dispatcher: telegram.dispatcher, sessions: telegram.sessions };
  }
});
