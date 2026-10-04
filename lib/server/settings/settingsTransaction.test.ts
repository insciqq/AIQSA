import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { applySettingsUpdateInTransaction, type SettingsTransactionClient } from "./settingsTransaction";

const storedSettings = {
  answerSoundEnabled: true,
  answerSoundId: "rise",
  browserNotificationsEnabled: true,
  defaultAssistantId: "assistant-1",
  defaultControlValues: {},
  defaultKnowledgePlan: null,
  defaultMcpMode: "auto",
  defaultProviderModel: null,
  defaultSearchPlan: null,
  defaultSkillsMode: "auto",
  defaultWorkspaceEnabled: true,
  sendWithEnter: true,
  showCitations: true,
  showReasoningBlocks: false
};

function transaction(assistantAvailable: boolean, ownerExists = true) {
  const statements: string[] = [];
  const update = vi.fn(async (_input: Prisma.UserSettingsUpdateArgs) => storedSettings);
  const deleteSubscriptions = vi.fn(async (_input: Prisma.BrowserPushSubscriptionDeleteManyArgs) => ({ count: 2 }));
  const tx = {
    browserPushSubscription: { deleteMany: deleteSubscriptions },
    $queryRaw: async (query: TemplateStringsArray | Prisma.Sql) => {
      const text = "sql" in query ? query.sql : query.join("?");
      statements.push(text.includes('FROM "User"') ? "owner" : text.includes(`"AssistantDefinition"`) ? "assistant" : "settings");
      if (text.includes('FROM "User"')) return ownerExists ? [{ id: "user-1" }] : [];
      if (text.includes(`"AssistantDefinition"`)) return assistantAvailable ? [{ id: "assistant-1" }] : [];
      return [{ defaultControlValues: {}, defaultProviderModelId: null, defaultSearchPlan: null, id: "settings-1" }];
    },
    userSettings: { update }
  } as unknown as SettingsTransactionClient;
  return { deleteSubscriptions, statements, tx, update };
}

describe("settings transaction", () => {
  it("locks the owner before the default Assistant and settings, and writes only an available default", async () => {
    const available = transaction(true);
    await expect(applySettingsUpdateInTransaction(available.tx, "user-1", { defaultAssistantId: "assistant-1" }, []))
      .resolves.toMatchObject({
        kind: "updated",
        settings: { defaultAssistantAvailable: true, defaultAssistantId: "assistant-1" }
      });
    expect(available.statements).toEqual(["owner", "assistant", "settings"]);
    expect(available.update.mock.calls[0]?.[0].data).toMatchObject({
      defaultAssistant: { connect: { id: "assistant-1" } }
    });

    const unavailable = transaction(false);
    await expect(applySettingsUpdateInTransaction(unavailable.tx, "user-1", { defaultAssistantId: "assistant-1" }, []))
      .resolves.toEqual({ kind: "assistant_not_available" });
    expect(unavailable.statements).toEqual(["owner", "assistant"]);
    expect(unavailable.update).not.toHaveBeenCalled();
  });

  it("clears without a lookup and leaves an untouched default for the caller to resolve", async () => {
    const cleared = transaction(false);
    await expect(applySettingsUpdateInTransaction(cleared.tx, "user-1", { defaultAssistantId: null }, []))
      .resolves.toMatchObject({ settings: { defaultAssistantAvailable: false } });
    expect(cleared.statements).toEqual(["owner", "settings"]);
    expect(cleared.update.mock.calls[0]?.[0].data).toMatchObject({ defaultAssistant: { disconnect: true } });

    const untouched = transaction(false);
    const result = await applySettingsUpdateInTransaction(untouched.tx, "user-1", { sendWithEnter: false }, []);
    expect(untouched.statements).toEqual(["owner", "settings"]);
    expect(result.kind === "updated" ? result.settings : null).not.toHaveProperty("defaultAssistantAvailable");
    expect(untouched.update.mock.calls[0]?.[0].data).not.toHaveProperty("defaultAssistant");
  });

  it("does not inspect defaults or mutate settings after the owner is removed", async () => {
    const missing = transaction(true, false);
    await expect(applySettingsUpdateInTransaction(missing.tx, "user-1", { defaultAssistantId: "assistant-1" }, []))
      .resolves.toEqual({ kind: "not_found" });
    expect(missing.statements).toEqual(["owner"]);
    expect(missing.update).not.toHaveBeenCalled();
  });

  it("removes every browser push subscription of the account when notifications are turned off", async () => {
    const off = transaction(true);
    await applySettingsUpdateInTransaction(off.tx, "user-1", { browserNotificationsEnabled: false }, []);
    expect(off.update.mock.calls[0]?.[0].data).toMatchObject({ browserNotificationsEnabled: false });
    expect(off.deleteSubscriptions).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(off.deleteSubscriptions.mock.invocationCallOrder[0]).toBeGreaterThan(off.update.mock.invocationCallOrder[0]!);

    for (const update of [{ browserNotificationsEnabled: true }, { sendWithEnter: false }]) {
      const kept = transaction(true);
      await applySettingsUpdateInTransaction(kept.tx, "user-1", update, []);
      expect(kept.deleteSubscriptions).not.toHaveBeenCalled();
    }
  });
});
