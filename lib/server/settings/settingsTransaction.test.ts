import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { applySettingsUpdateInTransaction, type SettingsTransactionClient } from "./settingsTransaction";

const storedSettings = {
  answerSoundEnabled: true,
  answerSoundId: "rise",
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

function transaction(assistantAvailable: boolean) {
  const statements: string[] = [];
  const update = vi.fn(async (_input: Prisma.UserSettingsUpdateArgs) => storedSettings);
  const tx = {
    $queryRaw: async (query: TemplateStringsArray | Prisma.Sql) => {
      const text = "sql" in query ? query.sql : query.join("?");
      statements.push(text.includes(`"AssistantDefinition"`) ? "assistant" : "settings");
      if (text.includes(`"AssistantDefinition"`)) return assistantAvailable ? [{ id: "assistant-1" }] : [];
      return [{ defaultControlValues: {}, defaultProviderModelId: null, defaultSearchPlan: null, id: "settings-1" }];
    },
    userSettings: { update }
  } as unknown as SettingsTransactionClient;
  return { statements, tx, update };
}

describe("settings transaction", () => {
  it("locks the default Assistant before the settings row and writes it only while available", async () => {
    const available = transaction(true);
    await expect(applySettingsUpdateInTransaction(available.tx, "user-1", { defaultAssistantId: "assistant-1" }, []))
      .resolves.toMatchObject({
        kind: "updated",
        settings: { defaultAssistantAvailable: true, defaultAssistantId: "assistant-1" }
      });
    expect(available.statements).toEqual(["assistant", "settings"]);
    expect(available.update.mock.calls[0]?.[0].data).toMatchObject({
      defaultAssistant: { connect: { id: "assistant-1" } }
    });

    const unavailable = transaction(false);
    await expect(applySettingsUpdateInTransaction(unavailable.tx, "user-1", { defaultAssistantId: "assistant-1" }, []))
      .resolves.toEqual({ kind: "assistant_not_available" });
    expect(unavailable.statements).toEqual(["assistant"]);
    expect(unavailable.update).not.toHaveBeenCalled();
  });

  it("clears without a lookup and leaves an untouched default for the caller to resolve", async () => {
    const cleared = transaction(false);
    await expect(applySettingsUpdateInTransaction(cleared.tx, "user-1", { defaultAssistantId: null }, []))
      .resolves.toMatchObject({ settings: { defaultAssistantAvailable: false } });
    expect(cleared.statements).toEqual(["settings"]);
    expect(cleared.update.mock.calls[0]?.[0].data).toMatchObject({ defaultAssistant: { disconnect: true } });

    const untouched = transaction(false);
    const result = await applySettingsUpdateInTransaction(untouched.tx, "user-1", { sendWithEnter: false }, []);
    expect(untouched.statements).toEqual(["settings"]);
    expect(result.kind === "updated" ? result.settings : null).not.toHaveProperty("defaultAssistantAvailable");
    expect(untouched.update.mock.calls[0]?.[0].data).not.toHaveProperty("defaultAssistant");
  });
});
