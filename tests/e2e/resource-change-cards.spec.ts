import { expect, test, type Page } from "@playwright/test";
import type { ChatDetailWire, ChatMessageWire } from "../../lib/contracts/chats";
import type { AssistantChangeCard, ResourceChangeCard, SecretChangeCard, SkillDeleteProposalCard } from "../../lib/contracts/resourceChanges";
import type { SkillSaveCard } from "../../lib/contracts/skillSaves";
import { matrixCatalog } from "./shell/catalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { captureState } from "./support/capture";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

// Settled answers whose cards changed the user's own secrets, Skills and Assistants, over a mocked owner API.
const model = matrixCatalog.models[0]!;
const chatId = "resource-cards-chat";
const sizes = [{ width: 1440, height: 900 }, { width: 820, height: 1180 }, { width: 390, height: 844 }];

test.setTimeout(240_000);

const secretBase = { previousName: null, proposalId: null, resource: "secret", valueReplaced: false, version: 1 } as const;
const secretSaved: SecretChangeCard = { ...secretBase, action: "created", envNames: [], kind: "text", name: "GitLab token",
  secretId: "10000000-0000-4000-8000-000000000001", versionId: "20000000-0000-4000-8000-000000000001" };
const secretUpdated: SecretChangeCard = { ...secretBase, action: "updated", envNames: ["SAUCEDEMO_USERNAME", "SAUCEDEMO_PASSWORD"],
  kind: "env", name: "Saucedemo", secretId: "10000000-0000-4000-8000-000000000002", valueReplaced: true,
  versionId: "20000000-0000-4000-8000-000000000002" };
const secretDelete: SecretChangeCard = { ...secretBase, action: "delete_proposed", envNames: [], kind: "text", name: "Old deploy key",
  proposalId: "30000000-0000-4000-8000-000000000003", secretId: "10000000-0000-4000-8000-000000000003",
  versionId: "20000000-0000-4000-8000-000000000003" };
const skillDelete: SkillDeleteProposalCard = { action: "delete_proposed", assistantCount: 1, name: "Report writer", proposalId: "proposal_1",
  resource: "skill", scheduledTasks: [{ taskId: "task_1", title: "Monday digest" }], shared: false, skillId: "skill_1", skillVersion: 3,
  version: 1 };
const assistantUpdated: AssistantChangeCard = { action: "updated", assistantId: "asst_1", audience: null,
  changes: [{ field: "instructions", summary: null }, { field: "model", summary: "GPT-5.5 → Claude Sonnet" }], consequences: null,
  definitionVersion: 4, instructionsDiff: { lines: [{ kind: "del", text: "Be brief." }, { kind: "add", text: "Be thorough." }], truncated: false },
  name: "Reviewer", proposalId: null, resource: "assistant", version: 1 };
const skillSaved: SkillSaveCard = { version: 1, saveId: "save_1", skillId: "skill_2", revisionId: "rev_2", name: "Invoice parser",
  outcome: "created", fromRevision: null, toRevision: 1, changeNote: null, copiedFrom: null, published: false,
  files: [{ path: "SKILL.md", change: "added", executable: false }, { path: "scripts/parse.py", change: "added", executable: true }],
  diffs: [], scheduledTasks: [], scheduledTasksTruncated: false };

const turns: readonly Readonly<{ ask: string; answer: string; cards?: ResourceChangeCard[]; skill?: SkillSaveCard }>[] = [
  { ask: "Save my GitLab token glpat-not-real.", answer: "Saved it as GitLab token.", cards: [secretSaved] },
  { ask: "Sign in to saucedemo with the new password.", answer: "Signed in and updated the saved password.", cards: [secretUpdated] },
  { ask: "Remove the old deploy key and the report writer Skill.", answer: "Confirm both deletions in the cards below.",
    cards: [secretDelete, skillDelete] },
  { ask: "Make the reviewer thorough and switch it to Claude.", answer: "Updated the Reviewer Assistant.", cards: [assistantUpdated] },
  { ask: "Save this as a Skill.", answer: "Saved the Invoice parser Skill.", skill: skillSaved }
];

function message(id: string, role: "assistant" | "user", content: string, parentMessageId: string | null,
  extra: Partial<ChatMessageWire> = {}): ChatMessageWire {
  return { id, role, content, parentMessageId, createdAt: "2026-10-27T09:00:00.000Z", status: "complete",
    citationMessageId: null, errorMessage: null, modelId: role === "assistant" ? model.modelId : null,
    modelRunId: null, provider: role === "assistant" ? model.provider : null, ...extra };
}

function chatFixture(): ChatDetailWire {
  const updatedAt = "2026-10-27T09:05:00.000Z";
  const messages: ChatMessageWire[] = [];
  turns.forEach((turn, index) => {
    messages.push(message(`turn-${index + 1}-question`, "user", turn.ask, messages.at(-1)?.id ?? null));
    messages.push(message(`turn-${index + 1}-answer`, "assistant", turn.answer, `turn-${index + 1}-question`, {
      artifactSummary: { citations: [], reasoningText: [], sources: [],
        ...(turn.cards ? { resourceChanges: turn.cards } : {}), ...(turn.skill ? { skillSaves: [turn.skill] } : {}) }
    }));
  });
  const leaf = messages.at(-1)!.id;
  return {
    assistant: null, id: chatId, title: "Account changes", createdAt: "2026-10-27T09:00:00.000Z", updatedAt,
    activeLeafMessageId: leaf, defaultModelId: model.modelId, defaultProvider: model.provider, folderId: null,
    pinned: false, messageCount: messages.length, usageStats: null, contextStats: { approximateActiveBranchInputTokens: 600 },
    pageInfo: { activeLeafMessageId: leaf, beforeCursor: null, hasOlder: false, snapshotUpdatedAt: updatedAt },
    workspace: { available: false, enabled: false, internetEnabled: false, sessionState: null },
    messages
  };
}

async function prepare(page: Page) {
  const chat = chatFixture();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
  await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
  await page.route(`**/api/chats/${chatId}`, (route) => route.fulfill({ json: { chat } }));
  // A settled card reads its resource once; a failed read keeps its verbs, which is the state these images show.
  await page.route(/\/api\/(me\/)?(skills|assistants)\//u, (route) => route.fulfill({ status: 503, json: { error: "unavailable" } }));
  const writes: unknown[] = [];
  await page.route("**/api/me/workspace/secrets", (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ status: 503, json: { error: "workspace_secret_unavailable" } });
    writes.push(route.request().postDataJSON());
    return route.fulfill({ headers: { "cache-control": "private, no-store" }, json: { secrets: [] } });
  });
  await page.route("**/api/chats/*/messages", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 409, json: { error: "unexpected_fixture_run" } }) : route.fallback());
  await signInWithLocalToken(page, `/c/${chatId}`);
  await expect(page.locator("[data-resource]")).toHaveCount(5, { timeout: 30_000 });
  return { writes };
}

test("resource change cards stay compact and every verb stays reachable at every size in both themes", async ({ page }, info) => {
  const { writes } = await prepare(page);
  const saved = page.locator("[data-resource='secret']").filter({ hasText: secretSaved.name });
  await expect(saved).toContainText("Secret saved · Text");
  const undo = saved.getByRole("button", { name: `Undo saving ${secretSaved.name}` });
  const updated = page.locator("[data-resource='secret']").filter({ hasText: secretUpdated.name });
  await expect(updated).toContainText("Secret updated · Environment · 2 variables");
  await expect(updated).not.toContainText("SAUCEDEMO_PASSWORD");
  await captureState(page, info, "secret-saved-updated", { anchor: updated, sizes, atEachSize: async () => {
    await expectWithinViewport(page, undo);
    await expectWithinViewport(page, updated.getByRole("link", { name: "Open Secrets" }));
    await expectNoHorizontalOverflow(page);
  } });

  const proposal = page.locator("[data-resource='secret']").filter({ hasText: secretDelete.name });
  const skill = page.locator("[data-resource='skill']").filter({ hasText: skillDelete.name });
  await expect(proposal.getByRole("button", { name: "Delete secret" })).toBeVisible();
  await expect(skill.getByRole("button", { name: "Keep Skill" })).toBeVisible();
  await captureState(page, info, "delete-proposals", { anchor: skill, sizes, atEachSize: async () => {
    await expectWithinViewport(page, skill.getByRole("button", { name: "Keep Skill" }));
    await expectNoHorizontalOverflow(page);
  } });

  const assistant = page.locator("[data-resource='assistant']").filter({ hasText: assistantUpdated.name });
  await expect(assistant).toContainText("Assistant updated");
  const skillSave = page.getByText(skillSaved.name, { exact: true }).first();
  await captureState(page, info, "assistant-updated-skill-saved", { anchor: skillSave, sizes, atEachSize: async () => {
    await expectWithinViewport(page, assistant.getByRole("link", { name: "Open in Studio" }));
    await expectNoHorizontalOverflow(page);
  } });

  await undo.click();
  await expect(saved).toContainText("Secret removed");
  await expect(saved.getByRole("status")).toContainText("Undone: the secret is deleted.");
  expect(writes).toEqual([{ action: "delete", id: secretSaved.secretId, expectedVersionId: secretSaved.versionId }]);
  await captureState(page, info, "secret-undone", { anchor: saved, sizes, atEachSize: async () => {
    await expectNoHorizontalOverflow(page);
  } });
});
