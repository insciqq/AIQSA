import type { TelegramAdminState, TelegramAdminUserLink, TelegramUserStatus } from "@/lib/contracts/telegram";

/**
 * Synthetic Telegram routes for the gallery states: `/api/me/telegram*` for
 * the Settings block and `/api/admin/telegram*` for the Control Center
 * section and the user page panel. They answer in the browser, so a state
 * renders without a session, a database or a bot.
 */
export type TelegramUserFixtureScenario = "access-off" | "bot-changed" | "linked" | "not-linked";
export type TelegramAdminFixtureScenario = "attention" | "on" | "setup";

export const TELEGRAM_FIXTURE_GROUP_IDS = [
  "6f1d2c34-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
  "7a2e3d45-2b3c-4d4e-9f0a-1b2c3d4e5f60"
] as const;

const DEEP_LINK = "https://t.me/aiqsa_team_bot?start=Qm9vdHN0cmFwLWxpbmstY29kZS1maXh0dXJlLW9ubHkx";

function userStatus(scenario: TelegramUserFixtureScenario): TelegramUserStatus {
  if (scenario === "linked") return { available: true, linkedAt: "2026-10-12T09:30:00.000Z", state: "linked", telegramUsername: "alex_rivera" };
  if (scenario === "access-off") {
    return { available: false, linkedAt: "2026-09-02T09:30:00.000Z", reasonCode: "telegram_access_off", state: "access_off", telegramUsername: "alex_rivera" };
  }
  if (scenario === "bot-changed") {
    return { available: true, linkedAt: "2026-09-02T09:30:00.000Z", reasonCode: "telegram_bot_changed", state: "bot_changed", telegramUsername: "alex_rivera" };
  }
  return { available: true, state: "not_linked" };
}

function adminState(scenario: TelegramAdminFixtureScenario, now: number): TelegramAdminState {
  const ago = (ms: number) => new Date(now - ms).toISOString();
  if (scenario === "setup") {
    return {
      botUsername: null, enabled: false, groupIds: [], restricted: false, tokenConfigured: false, version: 1,
      health: { lastFailureAt: null, lastFailureCode: null, lastPollAt: null, lastSuccessAt: null }
    };
  }
  return {
    botUsername: "aiqsa_team_bot",
    enabled: true,
    groupIds: [TELEGRAM_FIXTURE_GROUP_IDS[0]],
    health: scenario === "attention"
      ? { lastFailureAt: ago(40_000), lastFailureCode: "telegram_poll_conflict", lastPollAt: ago(40_000), lastSuccessAt: ago(3_600_000) }
      : { lastFailureAt: null, lastFailureCode: null, lastPollAt: ago(5_000), lastSuccessAt: ago(5_000) },
    restricted: true,
    tokenConfigured: true,
    version: 4
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

/** Replaces `fetch` for the Telegram routes until the returned restore runs. */
export function installTelegramFixtureApi(input: Readonly<{
  admin?: TelegramAdminFixtureScenario;
  user?: TelegramUserFixtureScenario;
}>): () => void {
  const original = window.fetch;
  let status = userStatus(input.user ?? "not-linked");
  let admin = adminState(input.admin ?? "setup", Date.now());
  let userLink: TelegramAdminUserLink = {
    displayName: "Alex Rivera", lastSeenAt: new Date(Date.now() - 3_600_000).toISOString(),
    linkedAt: "2026-10-12T09:30:00.000Z", state: "linked", telegramUsername: "alex_rivera"
  };
  const handle = async (path: string, init: RequestInit | undefined): Promise<Response | null> => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (path === "/api/me/telegram") {
      if (method === "DELETE") status = { available: true, state: "not_linked" };
      return json(status);
    }
    if (path === "/api/me/telegram/link-code" && method === "POST") {
      return json({ deepLink: DEEP_LINK, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    }
    if (path === "/api/admin/telegram") {
      if (method === "PATCH") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
        if (body.action === "test_and_save") {
          if (String(body.token).includes("reject")) return json({ error: "telegram_token_rejected" }, 422);
          admin = { ...admin, botUsername: "aiqsa_team_bot", tokenConfigured: true };
        }
        if (body.action === "enable" || body.action === "disable") admin = { ...admin, enabled: body.action === "enable" };
        if (body.action === "set_access") admin = { ...admin, groupIds: body.groupIds as string[], restricted: Boolean(body.restricted) };
        admin = { ...admin, version: admin.version + 1 };
      }
      return json(admin);
    }
    if (path.startsWith("/api/admin/telegram/users/")) {
      if (method === "DELETE") userLink = { state: "not_linked" };
      return json(userLink);
    }
    return null;
  };
  window.fetch = async (request: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url;
    const url = new URL(raw, window.location.origin);
    const answer = url.origin === window.location.origin ? await handle(url.pathname, init) : null;
    return answer ?? original(request, init);
  };
  return () => {
    window.fetch = original;
  };
}
