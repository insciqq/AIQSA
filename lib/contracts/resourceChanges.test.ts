// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  RESOURCE_CHANGE_CARDS_LIMIT,
  RESOURCE_CHANGE_TEXT_LIMITS,
  assistantLibraryPath,
  clipResourceChangeText,
  decodeResourceChangeCard,
  foldResourceChangeCards,
  type AssistantChangeCard,
  type SecretChangeCard,
  type SkillDeleteProposalCard
} from "./resourceChanges";

const secret: SecretChangeCard = { action: "created", envNames: ["GITLAB_TOKEN"], kind: "env", name: "GitLab", previousName: null, proposalId: null,
  resource: "secret", secretId: "10000000-0000-4000-8000-000000000001", valueReplaced: false, version: 1,
  versionId: "20000000-0000-4000-8000-000000000001" };
const skill: SkillDeleteProposalCard = { action: "delete_proposed", assistantCount: 1, name: "Report writer", proposalId: "proposal_1",
  resource: "skill", scheduledTasks: [{ taskId: "task_1", title: "Monday" }], shared: false, skillId: "skill_1", skillVersion: 3, version: 1 };
const assistant: AssistantChangeCard = { action: "updated", assistantId: "asst_1", audience: null,
  changes: [{ field: "instructions", summary: null }, { field: "model", summary: "GPT-5.5 → Claude" }], consequences: null, definitionVersion: 4,
  instructionsDiff: { lines: [{ kind: "del", text: "Be brief." }, { kind: "add", text: "Be thorough." }], truncated: false }, name: "Reviewer",
  proposalId: null, resource: "assistant", version: 1 };
const publishProposal: AssistantChangeCard = { ...assistant, action: "publish_proposed", audience: { groupId: "grp_1", groupName: "Backend", kind: "group" },
  changes: [], instructionsDiff: null, proposalId: "proposal_2" };

describe("resource change cards", () => {
  it("decode exactly what the tools write", () => {
    for (const card of [secret, skill, assistant, publishProposal]) expect(decodeResourceChangeCard(JSON.parse(JSON.stringify(card)))).toEqual(card);
    expect(decodeResourceChangeCard({ ...assistant, action: "delete_proposed", changes: [], consequences: { chatCount: 2, everyone: false,
      groupNames: [], pendingListingRequest: true }, instructionsDiff: null, proposalId: "proposal_3" })).toMatchObject({ consequences: { chatCount: 2 } });
    expect(decodeResourceChangeCard({ ...secret, action: "delete_proposed", proposalId: "8a6f1c1e-2b7d-4c9a-9f0e-3d5b7c1a2e4f" }))
      .toMatchObject({ proposalId: "8a6f1c1e-2b7d-4c9a-9f0e-3d5b7c1a2e4f" });
  });

  it.each([
    [{ ...secret, value: "glpat-synthetic" }],
    [{ ...secret, secretId: "not-a-uuid" }],
    [{ ...secret, valueReplaced: true }],
    [{ ...secret, previousName: "Old" }],
    [{ ...secret, envNames: ["1BAD"] }],
    [{ ...secret, proposalId: "proposal_1" }],
    [{ ...secret, action: "delete_proposed" }],
    [{ ...skill, action: "created" }],
    [{ ...skill, proposalId: null }],
    [{ ...skill, skillVersion: 0 }],
    [{ ...skill, skillVersion: undefined }],
    [{ ...skill, scheduledTasks: Array.from({ length: 6 }, (_, index) => ({ taskId: `task_${index}`, title: "t" })) }],
    [{ ...assistant, action: "created" }],
    [{ ...assistant, proposalId: "proposal_1" }],
    [{ ...publishProposal, proposalId: null }],
    [{ ...publishProposal, audience: null }],
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
    const many = Array.from({ length: RESOURCE_CHANGE_CARDS_LIMIT + 5 }, (_, index) => ({ ...skill, proposalId: `proposal_${index}` }));
    expect(foldResourceChangeCards(many)).toHaveLength(RESOURCE_CHANGE_CARDS_LIMIT);
  });

  it("keep two proposals of the same change as two questions, and one proposal delivered twice as one", () => {
    const again = { ...skill, proposalId: "proposal_9" };
    expect(foldResourceChangeCards([skill, again, skill])).toEqual([skill, again]);
    const republish = { ...publishProposal, proposalId: "proposal_8" };
    expect(foldResourceChangeCards([publishProposal, republish, publishProposal])).toEqual([publishProposal, republish]);
  });

  it("clip text to the decoder's UTF-16 limit without splitting a character", () => {
    expect(clipResourceChangeText("Backend", 200)).toBe("Backend");
    const astral = "𝔸".repeat(120);
    expect(astral.length).toBe(240);
    const title = clipResourceChangeText(astral, RESOURCE_CHANGE_TEXT_LIMITS.taskTitle);
    expect(title.length).toBeLessThanOrEqual(RESOURCE_CHANGE_TEXT_LIMITS.taskTitle);
    expect(title).toBe(`${"𝔸".repeat(59)}…`);
    expect(decodeResourceChangeCard({ ...skill, scheduledTasks: [{ taskId: "task_1", title }] })).not.toBeNull();
    expect(decodeResourceChangeCard({ ...skill, scheduledTasks: [{ taskId: "task_1", title: astral }] })).toBeNull();
    const group = clipResourceChangeText("g".repeat(250), RESOURCE_CHANGE_TEXT_LIMITS.groupName);
    expect(decodeResourceChangeCard({ ...publishProposal, audience: { groupId: "grp_1", groupName: group, kind: "group" } }))
      .toMatchObject({ audience: { groupName: `${"g".repeat(199)}…` } });
  });

  it("link an Assistant's Studio sheet", () => {
    expect(assistantLibraryPath("asst 1")).toBe("/?library=assistants&assistant=asst%201");
  });
});
