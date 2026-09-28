import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  availableAssistantIdentities,
  isAssistantArchivedFor,
  isAssistantAvailable,
  type AssistantBindingAccessClient
} from "./bindingAccess";

const avatar = {
  accents: [0, 4],
  backgroundShape: "circle",
  foregroundShape: "diamond",
  kind: "generated",
  paletteId: "ocean",
  recipeVersion: 1,
  rotations: [0, 2]
};

function recordingClient(rows: unknown[] = []) {
  const statements: Prisma.Sql[] = [];
  const client = {
    $queryRaw: async (query: Prisma.Sql) => {
      statements.push(query);
      return rows;
    }
  } as unknown as AssistantBindingAccessClient;
  return { client, statements };
}

describe("Assistant binding access", () => {
  it("runs one statement of the same shape for every Assistant id", async () => {
    const texts: string[] = [];
    for (const assistantId of ["missing", "foreign", "archived"]) {
      const { client, statements } = recordingClient();
      await expect(isAssistantAvailable(client, {
        assistantId,
        scope: { kind: "personal", userId: "user-1" }
      })).resolves.toBe(false);
      expect(statements).toHaveLength(1);
      expect(statements[0]!.values).toEqual([assistantId, "user-1", "user-1"]);
      texts.push(statements[0]!.sql);
    }
    expect(new Set(texts).size).toBe(1);
    expect(texts[0]).toContain(`definition."archivedAt" IS NULL`);
    expect(texts[0]).not.toContain("FOR KEY SHARE");
  });

  it("locks the definition for a write and checks a Project binding in Project scope", async () => {
    const personal = recordingClient([{ id: "assistant-1" }]);
    await expect(isAssistantAvailable(personal.client, {
      assistantId: "assistant-1",
      lock: true,
      scope: { kind: "personal", userId: "user-1" }
    })).resolves.toBe(true);
    expect(personal.statements[0]!.sql).toContain("FOR KEY SHARE OF definition");

    const project = recordingClient([{ id: "assistant-1" }]);
    await expect(isAssistantAvailable(project.client, {
      assistantId: "assistant-1",
      scope: { kind: "project", projectId: "project-1" }
    })).resolves.toBe(true);
    expect(project.statements[0]!.sql).toContain(`"ProjectAssistantBinding"`);
    expect(project.statements[0]!.sql).not.toContain(`"AssistantPublication"`);
    expect(project.statements[0]!.values).toEqual(["assistant-1", "project-1"]);
  });

  it("tells whether an archived Assistant is still available to the scope otherwise", async () => {
    const texts: string[] = [];
    for (const rows of [[], [{ id: "assistant-1" }]]) {
      const { client, statements } = recordingClient(rows);
      await expect(isAssistantArchivedFor(client, {
        assistantId: "assistant-1",
        scope: { kind: "personal", userId: "user-1" }
      })).resolves.toBe(rows.length === 1);
      expect(statements).toHaveLength(1);
      expect(statements[0]!.values).toEqual(["assistant-1", "user-1", "user-1"]);
      texts.push(statements[0]!.sql);
    }
    expect(new Set(texts).size).toBe(1);
    expect(texts[0]).toContain(`definition."archivedAt" IS NOT NULL`);
    expect(texts[0]).toContain(`"AssistantPublication"`);
  });

  it("returns identities of available Assistants from one deduplicated lookup", async () => {
    const empty = recordingClient();
    await expect(availableAssistantIdentities(empty.client, { assistantIds: [], userId: "user-1" }))
      .resolves.toEqual(new Map());
    expect(empty.statements).toHaveLength(0);

    const { client, statements } = recordingClient([
      { avatar, id: "assistant-1", name: "Helper" },
      { avatar: { kind: "unknown" }, id: "assistant-2", name: "Broken avatar" }
    ]);
    const identities = await availableAssistantIdentities(client, {
      assistantIds: ["assistant-1", "assistant-2", "assistant-1", "assistant-3"],
      userId: "user-1"
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]!.values).toEqual(["assistant-1", "assistant-2", "assistant-3", "user-1", "user-1"]);
    // An unreadable identity is left out rather than shown half-decoded.
    expect(identities).toEqual(new Map([["assistant-1", { avatar, name: "Helper" }]]));
  });
});
