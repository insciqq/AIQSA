// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  RESOURCE_CHANGE_CARDS_LIMIT,
  assistantLibraryPath,
  decodeResourceChangeCard,
  foldResourceChangeCards,
  type AssistantChangeCard,
  type SecretChangeCard,
  type SkillDeleteProposalCard
} from "./resourceChanges";

const secret: SecretChangeCard = { action: "created", envNames: ["GITLAB_TOKEN"], kind: "env", name: "GitLab", previousName: null, resource: "secret",
  secretId: "10000000-0000-4000-8000-000000000001", valueReplaced: false, version: 1, versionId: "20000000-0000-4000-8000-000000000001" };
const skill: SkillDeleteProposalCard = { action: "delete_proposed", assistantCount: 1, name: "Report writer", resource: "skill",
  scheduledTasks: [{ taskId: "task_1", title: "Monday" }], shared: false, skillId: "skill_1", version: 1 };
const assistant: AssistantChangeCard = { action: "updated", assistantId: "asst_1", audience: null,
  changes: [{ field: "instructions", summary: null }, { field: "model", summary: "GPT-5.5 → Claude" }], consequences: null, definitionVersion: 4,
  instructionsDiff: { lines: [{ kind: "del", text: "Be brief." }, { kind: "add", text: "Be thorough." }], truncated: false }, name: "Reviewer",
  resource: "assistant", version: 1 };

describe("resource change cards", () => {
  it("decode exactly what the tools write", () => {
    for (const card of [secret, skill, assistant]) expect(decodeResourceChangeCard(JSON.parse(JSON.stringify(card)))).toEqual(card);
    expect(decodeResourceChangeCard({ ...assistant, action: "publish_proposed", audience: { groupId: "grp_1", groupName: "Backend", kind: "group" },
      changes: [], instructionsDiff: null })).toMatchObject({ audience: { groupName: "Backend" } });
    expect(decodeResourceChangeCard({ ...assistant, action: "delete_proposed", changes: [], consequences: { chatCount: 2, everyone: false,
      groupNames: [], pendingListingRequest: true }, instructionsDiff: null })).toMatchObject({ consequences: { chatCount: 2 } });
  });

  it.each([
    [{ ...secret, value: "glpat-synthetic" }],
    [{ ...secret, secretId: "not-a-uuid" }],
    [{ ...secret, valueReplaced: true }],
    [{ ...secret, previousName: "Old" }],
    [{ ...secret, envNames: ["1BAD"] }],
    [{ ...skill, action: "created" }],
    [{ ...skill, scheduledTasks: Array.from({ length: 6 }, (_, index) => ({ taskId: `task_${index}`, title: "t" })) }],
    [{ ...assistant, action: "created" }],
    [{ ...assistant, action: "publish_proposed", changes: [], instructionsDiff: null }],
    [{ ...assistant, consequences: { chatCount: 1, everyone: false, groupNames: [], pendingListingRequest: false } }],
    [{ ...assistant, changes: [{ field: "owner", summary: null }] }],
    [{ ...assistant, definitionVersion: 0 }],
    [{ ...assistant, resource: "project" }],
    [{ ...assistant, version: 2 }]
  ])("refuse %j", (value) => {
    expect(decodeResourceChangeCard(value)).toBeNull();
  });

  it("fold an answer's cards in order, each once, within the limit", () => {
    const renamed: SecretChangeCard = { ...secret, action: "updated", name: "GitLab work", previousName: "GitLab", versionId: "20000000-0000-4000-8000-000000000002" };
    expect(foldResourceChangeCards([secret, { junk: true }, skill, secret, renamed, assistant])).toEqual([secret, skill, renamed, assistant]);
    const many = Array.from({ length: RESOURCE_CHANGE_CARDS_LIMIT + 5 }, (_, index) => ({ ...skill, skillId: `skill_${index}` }));
    expect(foldResourceChangeCards(many)).toHaveLength(RESOURCE_CHANGE_CARDS_LIMIT);
  });

  it("link an Assistant's Studio sheet", () => {
    expect(assistantLibraryPath("asst 1")).toBe("/?library=assistants&assistant=asst%201");
  });
});
