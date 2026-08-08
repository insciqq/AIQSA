import { describe, expect, it } from "vitest";
import {
  decodeKnowledgeBaseCreate,
  decodeKnowledgeBasePublication,
  decodeKnowledgeBaseUpdate
} from "./knowledge";

describe("Knowledge Base contracts", () => {
  it("normalizes bounded create and update inputs", () => {
    expect(decodeKnowledgeBaseCreate({
      description: "  Team references  ",
      embeddingDeploymentId: "embedding-1",
      name: "  Product docs  "
    })).toEqual({
      ok: true,
      value: {
        description: "Team references",
        embeddingDeploymentId: "embedding-1",
        name: "Product docs"
      }
    });
    expect(decodeKnowledgeBaseUpdate({
      archived: false,
      description: " Updated ",
      expectedVersion: 2
    })).toEqual({
      ok: true,
      value: { archived: false, description: "Updated", expectedVersion: 2 }
    });
  });

  it("rejects extra keys, empty updates, malformed ids, and over-bounds text", () => {
    expect(decodeKnowledgeBaseCreate({
      description: "",
      embeddingDeploymentId: "embedding 1",
      name: "Docs"
    })).toMatchObject({ ok: false });
    expect(decodeKnowledgeBaseCreate({
      description: "",
      embeddingDeploymentId: "embedding-1",
      name: "Docs",
      ownerUserId: "attacker"
    })).toMatchObject({ ok: false });
    expect(decodeKnowledgeBaseUpdate({ expectedVersion: 1 })).toMatchObject({ ok: false });
    expect(decodeKnowledgeBaseUpdate({ expectedVersion: 0, name: "Docs" })).toMatchObject({ ok: false });
  });

  it("enforces the publication scope/group pair", () => {
    expect(decodeKnowledgeBasePublication({ groupId: "group-1", scope: "group" })).toEqual({
      ok: true,
      value: { groupId: "group-1", scope: "group" }
    });
    expect(decodeKnowledgeBasePublication({ scope: "installation" })).toEqual({
      ok: true,
      value: { groupId: null, scope: "installation" }
    });
    expect(decodeKnowledgeBasePublication({ groupId: "group-1", scope: "installation" }))
      .toMatchObject({ ok: false });
    expect(decodeKnowledgeBasePublication({ groupId: null, scope: "group" }))
      .toMatchObject({ ok: false });
  });
});
