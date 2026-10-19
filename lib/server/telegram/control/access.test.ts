import { describe, expect, it, vi } from "vitest";
import type { TelegramLinkRecord } from "../store/links";
import { createPrismaTelegramAccessUserSource, createTelegramAccessResolver, type TelegramAccessUser } from "./access";
import type { TelegramEffectiveControl } from "./state";

const USER = "22222222-2222-4222-8222-222222222222";
const GROUP = "8a4f2a8e-5a8b-4c55-9c1e-0d4a1f6f9b10";
const OTHER_GROUP = "9b5f3b9f-6b9c-4d66-8d2f-1e5b2a7a0c21";
const BOT = 100000001;
const LINKED_AT = new Date("2026-10-18T10:00:00.000Z");

function control(overrides: Partial<TelegramEffectiveControl> = {}): TelegramEffectiveControl {
  return {
    bot: { generation: 1, id: BOT, token: "100000001:AAFakeTelegramBotTokenForTests_0000000", username: "aiqsa_test_bot" },
    enabled: true, groupIds: new Set(), restricted: false, tokenState: "ready", version: 3, ...overrides
  };
}

function link(overrides: Partial<TelegramLinkRecord> = {}): TelegramLinkRecord {
  return {
    agentEnabled: false, botId: BOT, currentChatId: null, displayName: "Alex Example", id: "link-1", lastSeenAt: LINKED_AT, linkedAt: LINKED_AT,
    pendingAssistantId: null, searchEnabled: true, selectedModelId: null, selectedProvider: null, telegramChatId: 200000001,
    telegramUserId: 200000001, telegramUsername: "alex_example", userId: USER, workspaceEnabled: false, ...overrides
  };
}

function resolver(state: { control: TelegramEffectiveControl; link: TelegramLinkRecord | null; user: TelegramAccessUser | null }) {
  return createTelegramAccessResolver({
    control: async () => state.control,
    links: { findByUserId: async (userId) => state.link?.userId === userId ? state.link : null },
    users: async () => state.user
  });
}

const activeUser: TelegramAccessUser = { activeGroupIds: [GROUP], scimDeactivatedAt: null, status: "active" };

describe("Telegram access", () => {
  it("allows a linked active user while the bot is on and open to everyone", async () => {
    const state = { control: control(), link: link(), user: activeUser };
    await expect(resolver(state).resolveTelegramAccess(USER)).resolves.toMatchObject({ allowed: true, link: { id: "link-1" } });
  });

  it.each([
    ["the bot is off", { control: control({ enabled: false }) }, "telegram_access_off"],
    ["the token is unreadable", { control: control({ bot: null, tokenState: "unreadable" }) }, "telegram_access_off"],
    ["the link names another bot", { link: link({ botId: 999 }) }, "telegram_bot_changed"],
    ["the account is disabled", { user: { ...activeUser, status: "disabled" } }, "telegram_access_off"],
    ["SCIM deactivated the account", { user: { ...activeUser, scimDeactivatedAt: new Date() } }, "telegram_access_off"],
    ["the account is gone", { user: null }, "telegram_access_off"],
    ["the bot is restricted to a group the user is not in", { control: control({ groupIds: new Set([OTHER_GROUP]), restricted: true }) },
      "telegram_access_off"],
    // Archived groups never reach the access check: the account source reads only memberships of live groups.
    ["the user's only allowed group is archived", { control: control({ groupIds: new Set([GROUP]), restricted: true }),
      user: { ...activeUser, activeGroupIds: [] } }, "telegram_access_off"]
  ])("refuses without touching the link when %s", async (_case, change, reasonCode) => {
    const state = { control: control(), link: link(), user: activeUser, ...change };
    const before = JSON.stringify(state.link);
    await expect(resolver(state).resolveTelegramAccess(USER)).resolves.toEqual({ allowed: false, link: state.link, reasonCode });
    expect(JSON.stringify(state.link)).toBe(before);
  });

  it("gives access back with the condition, without linking again", async () => {
    const state: { control: TelegramEffectiveControl; link: TelegramLinkRecord | null; user: TelegramAccessUser | null } = {
      control: control({ groupIds: new Set([GROUP]), restricted: true }), link: link(), user: { ...activeUser, activeGroupIds: [] }
    };
    const access = resolver(state);
    await expect(access.resolveTelegramAccess(USER)).resolves.toMatchObject({ allowed: false, reasonCode: "telegram_access_off" });
    state.user = activeUser;
    await expect(access.resolveTelegramAccess(USER)).resolves.toMatchObject({ allowed: true, link: { id: "link-1" } });
  });

  it("refuses an account without a link, or a link of another account", async () => {
    await expect(resolver({ control: control(), link: null, user: activeUser }).resolveTelegramAccess(USER))
      .resolves.toEqual({ allowed: false, link: null, reasonCode: "telegram_not_linked" });
    await expect(resolver({ control: control(), link: null, user: activeUser }).resolveTelegramAccess(USER, { link: link({ userId: "someone-else" }) }))
      .resolves.toEqual({ allowed: false, link: null, reasonCode: "telegram_not_linked" });
  });
});

describe("Telegram status projections", () => {
  it("shows the settings block when the user may link or has a link, with its state and no Telegram ids", async () => {
    await expect(resolver({ control: control(), link: null, user: activeUser }).userStatus(USER))
      .resolves.toEqual({ available: true, state: "not_linked" });
    await expect(resolver({ control: control({ enabled: false }), link: null, user: activeUser }).userStatus(USER))
      .resolves.toEqual({ available: false, state: "not_linked" });
    await expect(resolver({ control: control({ restricted: true }), link: null, user: activeUser }).userStatus(USER))
      .resolves.toEqual({ available: false, state: "not_linked" });
    const linked = await resolver({ control: control(), link: link(), user: activeUser }).userStatus(USER);
    expect(linked).toEqual({ available: true, linkedAt: LINKED_AT.toISOString(), state: "linked", telegramUsername: "alex_example" });
    expect(JSON.stringify(linked)).not.toContain("200000001");
    await expect(resolver({ control: control({ enabled: false }), link: link(), user: activeUser }).userStatus(USER)).resolves
      .toMatchObject({ available: true, reasonCode: "telegram_access_off", state: "access_off" });
    await expect(resolver({ control: control(), link: link({ botId: 7 }), user: activeUser }).userStatus(USER)).resolves
      .toMatchObject({ available: true, reasonCode: "telegram_bot_changed", state: "bot_changed" });
    await expect(resolver({ control: control(), link: link({ telegramUsername: "no" }), user: activeUser }).userStatus(USER)).resolves
      .not.toHaveProperty("telegramUsername");
  });

  it("gives administrators the link state, names and dates, and null for an unknown account", async () => {
    await expect(resolver({ control: control(), link: null, user: null }).adminUserLink(USER)).resolves.toBeNull();
    await expect(resolver({ control: control(), link: null, user: activeUser }).adminUserLink(USER)).resolves.toEqual({ state: "not_linked" });
    const view = await resolver({ control: control(), link: link(), user: { ...activeUser, status: "disabled" } }).adminUserLink(USER);
    expect(view).toEqual({
      displayName: "Alex Example", lastSeenAt: LINKED_AT.toISOString(), linkedAt: LINKED_AT.toISOString(), reasonCode: "telegram_access_off",
      state: "access_off", telegramUsername: "alex_example"
    });
  });
});

describe("Prisma account source", () => {
  it("reads status, SCIM deactivation and memberships of groups that are not archived in one query", async () => {
    const findUnique = vi.fn(async () => ({ groups: [{ groupId: GROUP }], scimDeactivatedAt: null, status: "active" }));
    const source = createPrismaTelegramAccessUserSource({ user: { findUnique } } as never);
    await expect(source(USER)).resolves.toEqual({ activeGroupIds: [GROUP], scimDeactivatedAt: null, status: "active" });
    expect(findUnique).toHaveBeenCalledWith({
      select: { groups: { select: { groupId: true }, where: { group: { archivedAt: null } } }, scimDeactivatedAt: true, status: true },
      where: { id: USER }
    });
  });
});
