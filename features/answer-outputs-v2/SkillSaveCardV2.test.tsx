import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillSaveCard } from "@/lib/contracts/skillSaves";
import { AnswerOutputsV2 } from "./AnswerOutputsV2";
import { SkillSaveCardsV2 } from "./SkillSaveCardV2";

const card: SkillSaveCard = {
  version: 1, saveId: "save-1", skillId: "skill-1", revisionId: "rev-4", name: "gitlab-digest", outcome: "updated",
  fromRevision: 3, toRevision: 4, changeNote: "Add commit summaries", copiedFrom: null, published: true,
  files: [
    { path: "SKILL.md", change: "changed", executable: false },
    { path: "digest.py", change: "added", executable: true },
    { path: "old.sh", change: "removed", executable: true },
    { path: "notes.txt", change: "unchanged", executable: false }
  ],
  diffs: [{ path: "SKILL.md", truncated: false, lines: [{ kind: "context", text: "Run digest." },
    { kind: "del", text: "Old step" }, { kind: "add", text: "Summarize commits" }] }],
  scheduledTasks: [{ taskId: "task-1", title: "Morning digest" }], scheduledTasksTruncated: false
};

function respond(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? "GET"} ${url}`;
    const match = Object.entries(routes).find(([route]) => key.startsWith(route));
    if (!match) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    const [, body] = match;
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const UNDO = "/api/me/skills/skill-1/saves/save-1/undo";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SkillSaveCardsV2", () => {
  it("shows the outcome, changed files with run markers, the note, publication and scheduled-task warning", async () => {
    respond({ [`GET ${UNDO}`]: { state: "available" } });
    render(<SkillSaveCardsV2 cards={[card]} />);
    const item = screen.getByTestId("skill-save-card");
    expect(item).toHaveTextContent("Skill updated · v3 → v4");
    expect(item).toHaveTextContent("gitlab-digest");
    expect(item).toHaveTextContent("Add commit summaries");
    expect(item).toHaveTextContent("Colleagues keep the published version until you share this Skill again.");
    expect(within(item).getByRole("note")).toHaveTextContent("Used by scheduled tasks: “Morning digest”. Their next run uses this version.");
    const files = within(item).getByRole("list", { name: "Files of gitlab-digest" });
    expect(within(files).getAllByRole("listitem").map((row) => row.getAttribute("data-change"))).toEqual(["changed", "added", "removed"]);
    expect(within(files).getAllByRole("listitem")[1]).toHaveTextContent("Runs");
    expect(item).toHaveTextContent("1 unchanged file");
    // Removed files have no saved version to view.
    expect(within(files).queryByRole("button", { name: "View saved old.sh" })).toBeNull();
    expect(within(item).getByLabelText("Changes in SKILL.md")).toHaveTextContent("− Old step");
    expect(within(item).getByRole("link", { name: "Open library" })).toHaveAttribute("href", "/?library=skills");
    await waitFor(() => expect(item).toHaveAttribute("data-undo", "available"));
    expect(within(item).getByRole("button", { name: "Undo saving gitlab-digest" })).toBeVisible();
  });

  it("undoes once and reports the restored version", async () => {
    const fetchMock = respond({ [`GET ${UNDO}`]: { state: "available" },
      [`POST ${UNDO}`]: { state: "undone", outcome: "restored", revision: 5 } });
    render(<SkillSaveCardsV2 cards={[card]} />);
    const item = screen.getByTestId("skill-save-card");
    fireEvent.click(within(item).getByRole("button", { name: "Undo saving gitlab-digest" }));
    await waitFor(() => expect(within(item).getByRole("status")).toHaveTextContent("previous content is current again as v5"));
    expect(within(item).queryByRole("button", { name: /Undo/u })).toBeNull();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("shows a later change as a conflict and a created Skill's Undo as archiving", async () => {
    respond({ [`GET ${UNDO}`]: { state: "conflict" } });
    render(<SkillSaveCardsV2 cards={[card]} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("the Skill changed after this save"));
    expect(screen.queryByRole("button", { name: /Undo/u })).toBeNull();
    cleanup();
    const created: SkillSaveCard = { ...card, outcome: "created", fromRevision: null, toRevision: 1, published: false,
      scheduledTasks: [], copiedFrom: "Team report", files: [{ path: "SKILL.md", change: "added", executable: false }], diffs: [] };
    respond({ [`GET ${UNDO}`]: { state: "available" }, [`POST ${UNDO}`]: { state: "undone", outcome: "archived", revision: null } });
    render(<SkillSaveCardsV2 cards={[created]} />);
    expect(screen.getByTestId("skill-save-card")).toHaveTextContent("Skill saved · Created v1");
    expect(screen.getByTestId("skill-save-card")).toHaveTextContent("Your own copy of “Team report”; the original is unchanged.");
    expect(screen.queryByRole("note")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Undo saving gitlab-digest" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("the Skill is archived"));
  });

  it("keeps Undo after a failed read, reports a failed Undo and never reads while the answer runs", async () => {
    const fetchMock = respond({ [`GET ${UNDO}`]: new Response("{}", { status: 503 }),
      [`POST ${UNDO}`]: new Response(JSON.stringify({ error: "skill_operation_failed" }), { status: 503 }) });
    render(<SkillSaveCardsV2 cards={[card]} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Undo saving gitlab-digest" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Undo failed. Try again."));
    expect(screen.getByRole("button", { name: "Undo saving gitlab-digest" })).toBeEnabled();
    cleanup();
    const live = respond({});
    render(<SkillSaveCardsV2 cards={[card]} live />);
    expect(live).not.toHaveBeenCalled();
  });

  it("opens the immutable saved file on demand", async () => {
    respond({ [`GET ${UNDO}`]: { state: "available" },
      "GET /api/me/skills/skill-1/revisions/rev-4/file?path=digest.py": { path: "digest.py", content: "#!/usr/bin/env python3\nprint(1)\n" } });
    render(<SkillSaveCardsV2 cards={[card]} />);
    fireEvent.click(screen.getByRole("button", { name: "View saved digest.py" }));
    expect(await screen.findByLabelText("Saved digest.py")).toHaveTextContent("print(1)");
    fireEvent.click(screen.getByRole("button", { name: "Hide saved digest.py" }));
    expect(screen.queryByLabelText("Saved digest.py")).toBeNull();
  });

  it("is part of a running and a settled answer's outputs", () => {
    respond({ [`GET ${UNDO}`]: { state: "available" } });
    const summary = { citations: [], reasoningText: [], skillSaves: [card], sources: [] };
    const { rerender } = render(<AnswerOutputsV2 artifact={summary} live />);
    expect(screen.getByTestId("skill-save-card")).toBeVisible();
    rerender(<AnswerOutputsV2 artifact={summary} />);
    expect(screen.getByTestId("skill-save-card")).toBeVisible();
  });
});
