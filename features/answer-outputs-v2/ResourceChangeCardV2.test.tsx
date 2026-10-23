import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeLiveThreadArtifacts, summarizeThreadArtifacts } from "@/components/app-shell/threadContent";
import type { AssistantChangeCard, ResourceChangeCard, SecretChangeCard, SkillDeleteProposalCard } from "@/lib/contracts/resourceChanges";
import { AnswerOutputsV2 } from "./AnswerOutputsV2";
import { ResourceChangeCardsV2 } from "./ResourceChangeCardV2";
// The cards' own stylesheet, so computed styles answer how their rows wrap.
import "./answer-outputs.css";

const SECRET_ID = "10000000-0000-4000-8000-000000000001";
const VERSION_ID = "20000000-0000-4000-8000-000000000001";
const secret: SecretChangeCard = { action: "created", envNames: [], kind: "text", name: "GitLab", previousName: null, proposalId: null,
  resource: "secret", secretId: SECRET_ID, valueReplaced: false, version: 1, versionId: VERSION_ID };
const skill: SkillDeleteProposalCard = { action: "delete_proposed", assistantCount: 2, name: "Report writer", proposalId: "proposal_0",
  resource: "skill", scheduledTasks: [{ taskId: "task_1", title: "Monday report" }], shared: true, skillId: "skill_1", skillVersion: 3, version: 1 };
const assistant: AssistantChangeCard = { action: "created", assistantId: "asst_1", audience: null, changes: [], consequences: null, definitionVersion: 1,
  instructionsDiff: null, name: "Reporter", proposalId: null, resource: "assistant", version: 1 };

type Route = unknown | Response | ((init?: RequestInit) => Response);
function respond(routes: Record<string, Route>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const match = Object.entries(routes).find(([route]) => key === route);
    if (!match) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    const [, value] = match;
    if (typeof value === "function") return (value as (init?: RequestInit) => Response)(init);
    return value instanceof Response ? value : new Response(JSON.stringify(value), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const summary = (versionId: string) => ({ secrets: [{ byteSize: 30, description: "", envNames: [], id: SECRET_ID, kind: "text", name: "GitLab",
  originalName: null, sshProtected: false, updatedAt: "2026-10-23T09:00:00.000Z", versionId }] });
const error = (code: string, status: number) => new Response(JSON.stringify({ error: code }), { status });
const bodies = (fetchMock: ReturnType<typeof respond>, method: string) => fetchMock.mock.calls
  .filter(([, init]) => init?.method === method).map(([url, init]) => [String(url), init?.body ? JSON.parse(String(init.body)) as unknown : null]);
const skillDetail = (skillId: string, version: number) => ({ skill: { archived: false, assistantUsageCount: 2, audiences: [], canDelete: true,
  canEdit: true, canPublish: true, canUnshare: false, description: "Weekly", id: skillId, instructionCharacterCount: 6, instructions: "Write.",
  name: "Report writer", owned: true, owner: { displayName: "Viewer" }, ownerDisplayName: "Viewer", scope: { kind: "owner" },
  updatedAt: "2026-10-23T09:00:00.000Z", version, workspaceUsageCount: 0 } });
let unique = 0;
/** Cards on one page remember outcomes by identity; each test uses its own (a proposal is its own identity). */
const fresh = <T extends ResourceChangeCard>(card: T): T => {
  unique += 1;
  if (card.action === "delete_proposed" || card.action === "publish_proposed") return { ...card, proposalId: `proposal_${unique}` };
  return card.resource === "secret" ? { ...card, versionId: `20000000-0000-4000-8000-${String(unique).padStart(12, "0")}` }
    : card.resource === "assistant" ? { ...card, definitionVersion: card.definitionVersion + unique * 10 } : card;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ResourceChangeCardsV2: secrets", () => {
  it("shows a saved secret with a link and undoes it once, guarded by the saved revision", async () => {
    const card = fresh(secret);
    const fetchMock = respond({ "GET /api/me/workspace/secrets": summary(card.versionId), "POST /api/me/workspace/secrets": { secrets: [] } });
    render(<ResourceChangeCardsV2 cards={[card]} />);
    const item = screen.getByTestId("resource-change-card");
    expect(item).toHaveTextContent("Secret saved");
    expect(item).toHaveTextContent("GitLab");
    expect(item).toHaveTextContent("Text");
    expect(within(item).getByRole("link", { name: "Open Secrets" })).toHaveAttribute("href", "/?library=secrets");
    await waitFor(() => expect(item).toHaveAttribute("data-state", "current"));
    fireEvent.click(within(item).getByRole("button", { name: "Undo saving GitLab" }));
    await waitFor(() => expect(within(item).getByRole("status")).toHaveTextContent("Undone: the secret is deleted."));
    expect(item).toHaveTextContent("Secret removed");
    expect(within(item).queryByRole("button")).toBeNull();
    expect(bodies(fetchMock, "POST")).toEqual([["/api/me/workspace/secrets", { action: "delete", expectedVersionId: card.versionId, id: SECRET_ID }]]);
  });

  it("offers no Undo once the secret changed, and never reads state while the answer runs", async () => {
    const card = fresh(secret);
    respond({ "GET /api/me/workspace/secrets": summary("20000000-0000-4000-8000-0000000000ff") });
    render(<ResourceChangeCardsV2 cards={[card]} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Undo is not available: the secret changed after this"));
    expect(screen.queryByRole("button", { name: /Undo/u })).toBeNull();
    cleanup();
    const fetchMock = respond({});
    render(<ResourceChangeCardsV2 cards={[fresh(secret)]} live />);
    expect(screen.getByRole("button", { name: "Undo saving GitLab" })).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says what an update did without offering Undo", () => {
    respond({});
    render(<ResourceChangeCardsV2 cards={[{ ...secret, action: "updated", envNames: ["GITLAB_TOKEN"], kind: "env", name: "GitLab work",
      previousName: "GitLab", valueReplaced: true }]} />);
    const item = screen.getByTestId("resource-change-card");
    expect(item).toHaveTextContent("Secret updated");
    expect(item).toHaveTextContent("Environment · GITLAB_TOKEN");
    expect(item).toHaveTextContent("Renamed from “GitLab”.");
    expect(item).toHaveTextContent("The value was replaced; earlier values are not kept.");
    expect(within(item).queryByRole("button")).toBeNull();
  });

  it("asks before deleting, deletes only on the click and keeps the secret on Keep", async () => {
    const card = fresh({ ...secret, action: "delete_proposed" as const });
    const fetchMock = respond({ "GET /api/me/workspace/secrets": summary(card.versionId), "POST /api/me/workspace/secrets": { secrets: [] } });
    render(<ResourceChangeCardsV2 cards={[card]} />);
    const question = screen.getByRole("group", { name: "Delete GitLab" });
    expect(question).toHaveTextContent("Delete “GitLab”? Chats and the Workspace stop receiving it. This cannot be undone.");
    expect(bodies(fetchMock, "POST")).toEqual([]);
    fireEvent.click(within(question).getByRole("button", { name: "Delete secret" }));
    await waitFor(() => expect(screen.getByTestId("resource-change-card")).toHaveTextContent("Secret deleted"));
    expect(bodies(fetchMock, "POST")).toEqual([["/api/me/workspace/secrets", { action: "delete", expectedVersionId: card.versionId, id: SECRET_ID }]]);
    expect(screen.queryByRole("group")).toBeNull();
    cleanup();
    respond({ "GET /api/me/workspace/secrets": summary(VERSION_ID) });
    render(<ResourceChangeCardsV2 cards={[fresh({ ...secret, action: "delete_proposed" as const })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Keep secret" }));
    expect(screen.getByTestId("resource-change-card")).toHaveTextContent("Secret kept");
    await waitFor(() => expect(screen.getByText("Secret kept")).toHaveFocus());
  });

  it("asks again when a running answer proposes the same deletion again, and keeps each decline", () => {
    const first = fresh({ ...secret, action: "delete_proposed" as const });
    const fetchMock = respond({});
    const { rerender } = render(<ResourceChangeCardsV2 cards={[first]} live />);
    fireEvent.click(screen.getByRole("button", { name: "Keep secret" }));
    // The same answer proposes it again: a second card asks while the first keeps the user's answer.
    const second = fresh({ ...secret, action: "delete_proposed" as const });
    rerender(<ResourceChangeCardsV2 cards={[first, second]} live />);
    const [kept, asking] = screen.getAllByTestId("resource-change-card");
    expect(kept).toHaveTextContent("Secret kept");
    expect(within(kept!).queryByRole("group")).toBeNull();
    expect(within(asking!).getByRole("group", { name: "Delete GitLab" })).toBeVisible();
    fireEvent.click(within(asking!).getByRole("button", { name: "Keep secret" }));
    cleanup();
    // The settled answer mounts both again: neither asks.
    render(<ResourceChangeCardsV2 cards={[first, second]} />);
    expect(screen.getAllByTestId("resource-change-card").map((card) => card.textContent)).toEqual([
      expect.stringContaining("Secret kept"), expect.stringContaining("Secret kept")]);
    expect(screen.queryByRole("group")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes nothing when the secret changed after the proposal", async () => {
    const card = fresh({ ...secret, action: "delete_proposed" as const });
    respond({ "POST /api/me/workspace/secrets": error("workspace_secret_conflict", 409) });
    render(<ResourceChangeCardsV2 cards={[card]} live />);
    fireEvent.click(screen.getByRole("button", { name: "Delete secret" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("The secret changed after this proposal, so nothing was deleted."));
    expect(screen.getByRole("link", { name: "Open Secrets" })).toBeVisible();
  });
});

describe("ResourceChangeCardsV2: Skills", () => {
  it("names what deleting changes and deletes through the library on the click", async () => {
    const card = fresh(skill);
    const fetchMock = respond({ [`DELETE /api/me/skills/${card.skillId}`]: new Response(null, { status: 204 }) });
    render(<ResourceChangeCardsV2 cards={[card]} live />);
    const item = screen.getByTestId("resource-change-card");
    expect(item).toHaveTextContent("Delete Skill?");
    expect(within(item).getByRole("list", { name: "What deleting changes" })).toHaveTextContent(
      "Linked by 2 Assistants, which lose it.Shared with colleagues, who lose access.Pinned by scheduled tasks “Monday report”");
    fireEvent.click(within(item).getByRole("button", { name: "Delete Skill" }));
    await waitFor(() => expect(item).toHaveTextContent("Skill deleted"));
    // Guarded by the version the proposal saw.
    expect(bodies(fetchMock, "DELETE")).toEqual([[`/api/me/skills/${card.skillId}`, { expectedVersion: card.skillVersion }]]);
  });

  it("deletes nothing when a revision was saved after the proposal", async () => {
    const card = fresh(skill);
    const fetchMock = respond({ [`DELETE /api/me/skills/${card.skillId}`]: () => error("skill_version_conflict", 409) });
    render(<ResourceChangeCardsV2 cards={[card]} live />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Skill" }));
    const item = screen.getByTestId("resource-change-card");
    await waitFor(() => expect(within(item).getByRole("status")).toHaveTextContent(
      "The Skill changed after this proposal, so nothing was deleted. Review it in Studio › Skills."));
    expect(item).toHaveTextContent("Skill not deleted");
    expect(within(item).queryByRole("group")).toBeNull();
    expect(within(item).getByRole("link", { name: "Open library" })).toBeVisible();
    expect(bodies(fetchMock, "DELETE")).toHaveLength(1);
  });

  it("asks a settled answer's question only while the Skill is the version the proposal saw", async () => {
    const card = fresh(skill);
    respond({ [`GET /api/me/skills/${card.skillId}`]: skillDetail(card.skillId, card.skillVersion + 1) });
    render(<ResourceChangeCardsV2 cards={[card]} />);
    await waitFor(() => expect(screen.getByTestId("resource-change-card")).toHaveTextContent("Skill not deleted"));
    expect(screen.queryByRole("group")).toBeNull();
    cleanup();
    const current = fresh(skill);
    respond({ [`GET /api/me/skills/${current.skillId}`]: skillDetail(current.skillId, current.skillVersion) });
    render(<ResourceChangeCardsV2 cards={[current]} />);
    await waitFor(() => expect(screen.getByTestId("resource-change-card")).toHaveAttribute("data-state", "asking"));
    expect(screen.getByRole("group", { name: "Delete Report writer" })).toBeVisible();
  });

  it("says a Skill that is gone is no longer available", async () => {
    const card = fresh(skill);
    respond({ [`GET /api/me/skills/${card.skillId}`]: error("skill_not_available", 404) });
    render(<ResourceChangeCardsV2 cards={[card]} />);
    await waitFor(() => expect(screen.getByTestId("resource-change-card")).toHaveTextContent("Skill no longer available"));
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByRole("link", { name: "Open library" })).toHaveAttribute("href", "/?library=skills");
  });
});

describe("ResourceChangeCardsV2: Assistants", () => {
  it("links a new Assistant and undoes it by archiving the version it created", async () => {
    const card = fresh(assistant);
    // The Studio client reads a 204 as success without a detail to decode.
    const fetchMock = respond({ "PATCH /api/me/assistants/asst_1": () => new Response(null, { status: 204 }) });
    render(<ResourceChangeCardsV2 cards={[card]} live />);
    const item = screen.getByTestId("resource-change-card");
    expect(within(item).getByRole("link", { name: "Open in Studio" })).toHaveAttribute("href", "/?library=assistants&assistant=asst_1");
    expect(within(item).getByRole("link", { name: "Start a chat" })).toHaveAttribute("href", "/assistant/asst_1");
    fireEvent.click(within(item).getByRole("button", { name: "Undo creating Reporter" }));
    await waitFor(() => expect(item).toHaveTextContent("Assistant archived"));
    expect(bodies(fetchMock, "PATCH")).toEqual([["/api/me/assistants/asst_1", { archived: true, expectedVersion: card.definitionVersion }]]);
  });

  it("starts the chat through the shell, never by a client-side route change the shell ignores", () => {
    respond({});
    const onStartAssistantChat = vi.fn();
    render(<AnswerOutputsV2 artifact={{ citations: [], reasoningText: [], resourceChanges: [fresh(assistant)], sources: [] }} live
      onStartAssistantChat={onStartAssistantChat} />);
    const link = screen.getByRole("link", { name: "Start a chat" });
    // A modified click keeps the link's own behavior: a new tab loads the entry page.
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    expect(onStartAssistantChat).not.toHaveBeenCalled();
    // A plain click is the shell's navigation alone.
    expect(fireEvent.click(link)).toBe(false);
    expect(onStartAssistantChat).toHaveBeenCalledExactlyOnceWith("asst_1");
  });

  it("opens Studio links through the shell, so the address keeps naming the shown chat", () => {
    respond({});
    const onOpenLibrary = vi.fn();
    render(<AnswerOutputsV2 artifact={{ citations: [], reasoningText: [], sources: [],
      resourceChanges: [fresh(assistant), fresh(secret)] }} live
      onOpenLibrary={onOpenLibrary} />);
    expect(fireEvent.click(screen.getByRole("link", { name: "Open in Studio" }))).toBe(false);
    expect(fireEvent.click(screen.getByRole("link", { name: "Open Secrets" }))).toBe(false);
    expect(onOpenLibrary.mock.calls).toEqual([["/?library=assistants&assistant=asst_1"], ["/?library=secrets"]]);
    expect(fireEvent.click(screen.getByRole("link", { name: "Open in Studio" }), { metaKey: true })).toBe(true);
    expect(onOpenLibrary).toHaveBeenCalledTimes(2);
  });

  it("keeps a later change instead of undoing it", async () => {
    respond({ "PATCH /api/me/assistants/asst_1": error("assistant_version_conflict", 409) });
    render(<ResourceChangeCardsV2 cards={[fresh(assistant)]} live />);
    fireEvent.click(screen.getByRole("button", { name: "Undo creating Reporter" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Undo is not available: the Assistant changed after this"));
    expect(screen.queryByRole("button", { name: /Undo/u })).toBeNull();
  });

  it("lists what an edit changed with the instructions diff", () => {
    respond({});
    render(<ResourceChangeCardsV2 cards={[{ ...assistant, action: "updated", changes: [{ field: "instructions", summary: null },
      { field: "model", summary: "GPT-5.5 → Claude Sonnet" }], instructionsDiff: { lines: [{ kind: "del", text: "Be brief." },
      { kind: "add", text: "Be thorough." }], truncated: false } }]} />);
    const changes = screen.getByRole("list", { name: "Changes to Reporter" });
    expect(changes).toHaveTextContent("Instructions changed");
    expect(changes).toHaveTextContent("Model: GPT-5.5 → Claude Sonnet");
    expect(screen.getByLabelText("Changes in the instructions of Reporter")).toHaveTextContent("− Be brief.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("asks before deleting with the consequences and deletes the version it named", async () => {
    const card = fresh({ ...assistant, action: "delete_proposed" as const, consequences: { chatCount: 3, everyone: false, groupNames: ["Backend"],
      pendingListingRequest: true } });
    const fetchMock = respond({ "DELETE /api/me/assistants/asst_1": new Response(null, { status: 204 }) });
    render(<ResourceChangeCardsV2 cards={[card]} live />);
    expect(screen.getByRole("list", { name: "What deleting changes" })).toHaveTextContent(
      "3 chats use it; they stay open and show it as deleted.Published to Backend; their members lose it.Its listing request is withdrawn.");
    fireEvent.click(screen.getByRole("button", { name: "Delete Assistant" }));
    await waitFor(() => expect(screen.getByTestId("resource-change-card")).toHaveTextContent("Assistant deleted"));
    expect(bodies(fetchMock, "DELETE")).toEqual([["/api/me/assistants/asst_1", { expectedVersion: card.definitionVersion }]]);
  });

  it("publishes to a group or requests a listing for everyone only on the click, and explains a refusal", async () => {
    const group = fresh({ ...assistant, action: "publish_proposed" as const, audience: { groupId: "grp_1", groupName: "Backend", kind: "group" as const } });
    const fetchMock = respond({ "POST /api/me/assistants/asst_1/publications": () => error("assistant_skill_audience_mismatch", 409),
      "POST /api/me/assistants/asst_1/listing-requests": () => error("assistant_listing_request_not_needed", 409) });
    render(<ResourceChangeCardsV2 cards={[group]} live />);
    expect(screen.getByRole("group", { name: "Publish Reporter" })).toHaveTextContent("Publish “Reporter” to members of Backend?");
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Share every linked Skill with this audience first"));
    // Guarded by the definition version the proposal saw.
    expect(bodies(fetchMock, "POST")).toEqual([["/api/me/assistants/asst_1/publications",
      { expectedVersion: group.definitionVersion, groupId: "grp_1", scope: "group" }]]);
    cleanup();
    const everyone = fresh({ ...assistant, action: "publish_proposed" as const, audience: { kind: "everyone" as const } });
    render(<ResourceChangeCardsV2 cards={[everyone]} live />);
    fireEvent.click(screen.getByRole("button", { name: "Request listing" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("As an administrator, publish it for everyone in Studio › Assistants."));
    expect(bodies(fetchMock, "POST").at(-1)).toEqual(["/api/me/assistants/asst_1/listing-requests", { expectedVersion: everyone.definitionVersion }]);
    cleanup();
    respond({ "POST /api/me/assistants/asst_1/publications": { publication: {} } });
    render(<ResourceChangeCardsV2 cards={[fresh(group)]} live />);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Members of Backend can use it now."));
  });

  it("publishes nothing when the Assistant was saved after the proposal", async () => {
    const card = fresh({ ...assistant, action: "publish_proposed" as const, audience: { groupId: "grp_1", groupName: "Backend", kind: "group" as const } });
    const fetchMock = respond({ "POST /api/me/assistants/asst_1/publications": () => error("assistant_version_conflict", 409) });
    render(<ResourceChangeCardsV2 cards={[card]} live />);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    const item = screen.getByTestId("resource-change-card");
    await waitFor(() => expect(within(item).getByRole("status")).toHaveTextContent(
      "The Assistant changed after this proposal, so nothing was done. Review it in Studio › Assistants."));
    expect(item).toHaveTextContent("Not published");
    expect(within(item).queryByRole("group")).toBeNull();
    expect(bodies(fetchMock, "POST")).toHaveLength(1);
  });

  it("asks a settled answer's publication question only while the Assistant still exists", async () => {
    const card = fresh({ ...assistant, action: "publish_proposed" as const, audience: { groupId: "grp_1", groupName: "Backend", kind: "group" as const } });
    const fetchMock = respond({});
    render(<ResourceChangeCardsV2 cards={[card]} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("This Assistant no longer exists."));
    expect(screen.getByTestId("resource-change-card")).toHaveTextContent("Not published");
    expect(screen.queryByRole("group")).toBeNull();
    expect(bodies(fetchMock, "POST")).toEqual([]);
  });
});

describe("ResourceChangeCardsV2: narrow screens", () => {
  it("lets every row of verbs wrap whole inside its card instead of running past its edge", () => {
    respond({});
    const cards = [
      fresh(secret),
      fresh({ ...secret, action: "updated" as const, previousName: "GitLab old" }),
      fresh({ ...secret, action: "delete_proposed" as const }),
      fresh(skill),
      fresh(assistant),
      fresh({ ...assistant, action: "updated" as const, changes: [{ field: "name" as const, summary: "Was “Writer”" }] }),
      fresh({ ...assistant, action: "delete_proposed" as const, consequences: { chatCount: 3, everyone: true, groupNames: ["Backend"],
        pendingListingRequest: true } }),
      fresh({ ...assistant, action: "publish_proposed" as const, audience: { groupId: "grp_1", groupName: "Backend", kind: "group" as const } })
    ];
    render(<ResourceChangeCardsV2 cards={cards} live />);
    const items = screen.getAllByTestId("resource-change-card");
    expect(items).toHaveLength(cards.length);
    for (const item of items) {
      expect(getComputedStyle(item).flexWrap).toBe("wrap");
      const rows = item.querySelectorAll(".v2-resource-change-card-actions, .v2-resource-change-card-confirm, .v2-resource-change-card-confirm > span");
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(getComputedStyle(row).flexWrap).toBe("wrap");
        expect(getComputedStyle(row).flexShrink).not.toBe("0");
      }
    }
    // A new Assistant's three verbs share one row, which shrinks to the card's width and wraps there.
    const created = within(items[4]!).getByRole("link", { name: "Open in Studio" }).closest(".v2-resource-change-card-actions") as HTMLElement;
    expect(within(created).getByRole("button", { name: "Undo creating Reporter" })).toBeVisible();
    expect(within(created).getByRole("link", { name: "Start a chat" })).toBeVisible();
    const style = getComputedStyle(created);
    expect([style.flexShrink, style.flexWrap, style.maxWidth]).toEqual(["1", "wrap", "100%"]);
    expect(["0", "0px"]).toContain(style.minWidth);
  });
});

describe("resource change cards in an answer", () => {
  it("render while the answer runs and once it settles, and a live summary never drops a saved card", () => {
    respond({});
    const events = [{ data: { artifactType: "resource_change", payload: secret }, type: "artifact" }];
    const live = summarizeThreadArtifacts(events as never);
    expect(live?.resourceChanges).toEqual([secret]);
    const merged = mergeLiveThreadArtifacts({ citations: [], reasoningText: [], resourceChanges: [skill], sources: [] }, live);
    expect(merged?.resourceChanges).toEqual([skill, secret]);
    render(<AnswerOutputsV2 artifact={merged} live />);
    expect(screen.getAllByTestId("resource-change-card")).toHaveLength(2);
    cleanup();
    render(<AnswerOutputsV2 artifact={{ citations: [], reasoningText: [], resourceChanges: [fresh(secret)], sources: [] }} />);
    expect(screen.getByRole("region", { name: "Changes to your resources" })).toBeVisible();
  });
});
