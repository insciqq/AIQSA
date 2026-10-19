import { describe, expect, it, vi } from "vitest";
import { revokeAllTelegramLinks, revokeTelegramLinksForUser } from "./revocation";

function transaction(links = 1) {
  return {
    telegramLink: { deleteMany: vi.fn(async () => ({ count: links })) },
    telegramLinkCode: { deleteMany: vi.fn(async () => ({ count: 2 })) }
  };
}

describe("Telegram link revocation", () => {
  it("ends one account's link and link codes inside the caller's transaction", async () => {
    const tx = transaction();
    await expect(revokeTelegramLinksForUser(tx as never, { now: new Date(), reason: "password_reset", userId: "user-1" })).resolves.toBe(1);
    expect(tx.telegramLinkCode.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(tx.telegramLink.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
  });

  it("ends every link and code for the administrator's revoke-all", async () => {
    const tx = transaction(3);
    await expect(revokeAllTelegramLinks(tx as never, { now: new Date(), reason: "admin_revoke_all" })).resolves.toBe(3);
    expect(tx.telegramLinkCode.deleteMany).toHaveBeenCalledWith({});
    expect(tx.telegramLink.deleteMany).toHaveBeenCalledWith({});
  });
});
