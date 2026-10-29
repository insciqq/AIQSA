import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentChangeCard } from "@/lib/contracts/resourceChanges";
import { ResourceChangeCardsV2 } from "./ResourceChangeCardV2";

type Route = unknown | Response;
function respond(routes: Record<string, Route>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const match = Object.entries(routes).find(([route]) => key === route);
    if (!match) return new Response(JSON.stringify({ error: "subagent_not_found" }), { status: 404 });
    const value = match[1];
    return value instanceof Response ? value.clone() : new Response(JSON.stringify(value), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const bodies = (fetchMock: ReturnType<typeof respond>, method: string) => fetchMock.mock.calls
  .filter(([, init]) => init?.method === method).map(([url, init]) => [String(url), init?.body ? JSON.parse(String(init.body)) as unknown : null]);

let unique = 0;
function card(patch: Partial<SubagentChangeCard> = {}): SubagentChangeCard {
  unique += 1;
  return { version: 1, resource: "subagent", action: "created", definitionId: `def_${unique}`, definitionVersion: 1, name: "browser", previousName: null,
    changes: [], instructionsDiff: null, undoRevisionId: null, consequences: null, proposalId: null, ...patch };
}
const view = (id: string, version: number) => ({ definition: { description: "Browse.", effort: null, id, instructions: "Go.", modelAvailable: true,
  modelDisplayName: null, modelId: null, name: "browser", previousRevisionId: null, revisionId: "rev_9", revisionNumber: version, tools: null,
  updatedAt: "2026-10-30T10:00:00.000Z", version } });
const noContent = () => new Response(null, { status: 204 });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ResourceChangeCardsV2: custom sub-agents", () => {
  it("undoes a creation by deleting it at the created version", async () => {
    const created = card();
    const path = `/api/me/subagents/${created.definitionId}`;
    const fetchMock = respond({ [`GET ${path}`]: view(created.definitionId, 1), [`DELETE ${path}`]: noContent() });
    render(<ResourceChangeCardsV2 cards={[created]} />);
    expect(screen.getByText("Sub-agent created")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open in Studio" })).toHaveAttribute("href", "/?library=subagents");
    fireEvent.click(await screen.findByRole("button", { name: "Undo creating browser" }));
    expect(await screen.findByText("Sub-agent removed")).toBeVisible();
    expect(bodies(fetchMock, "DELETE")).toEqual([[path, { expectedVersion: 1 }]]);
    expect(screen.queryByRole("button", { name: /Undo/u })).toBeNull();
  });

  it("undoes an edit by restoring the previous revision, and says what changed", async () => {
    const updated = card({ action: "updated", changes: [{ field: "model", summary: "Cheap Model" }, { field: "instructions", summary: null }],
      definitionVersion: 2, instructionsDiff: { lines: [{ kind: "add", text: "Report sources." }], truncated: false }, name: "web", previousName: "browser",
      undoRevisionId: "rev_1" });
    const path = `/api/me/subagents/${updated.definitionId}`;
    const fetchMock = respond({ [`GET ${path}`]: view(updated.definitionId, 2), [`POST ${path}/restore`]: view(updated.definitionId, 3) });
    render(<ResourceChangeCardsV2 cards={[updated]} />);
    expect(screen.getByText("Sub-agent updated")).toBeVisible();
    expect(screen.getByText(/Model, Instructions/u)).toBeVisible();
    expect(screen.getByText("Show changes")).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "Undo changes to web" }));
    expect(await screen.findByText("Change undone")).toBeVisible();
    expect(bodies(fetchMock, "POST")).toEqual([[`${path}/restore`, { expectedVersion: 2, revisionId: "rev_1" }]]);
  });

  it("offers no Undo once the sub-agent changed, and reads nothing while the answer runs", async () => {
    const changed = card();
    respond({ [`GET /api/me/subagents/${changed.definitionId}`]: view(changed.definitionId, 4) });
    render(<ResourceChangeCardsV2 cards={[changed]} />);
    expect(await screen.findByText(/Undo is not available/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Undo/u })).toBeNull();
    cleanup();
    const fetchMock = respond({});
    render(<ResourceChangeCardsV2 cards={[card()]} live />);
    expect(screen.getByRole("button", { name: "Undo creating browser" })).toBeEnabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks before deleting, names the consequences and deletes only on the click", async () => {
    const proposal = card({ action: "delete_proposed", consequences: { threadCount: 2 }, proposalId: `proposal_${unique}` });
    const path = `/api/me/subagents/${proposal.definitionId}`;
    const fetchMock = respond({ [`GET ${path}`]: view(proposal.definitionId, 1), [`DELETE ${path}`]: noContent() });
    render(<ResourceChangeCardsV2 cards={[proposal]} />);
    const consequences = screen.getByRole("list", { name: "What deleting changes" });
    expect(within(consequences).getByText(/2 sub-agents in your chats/u)).toBeVisible();
    expect(bodies(fetchMock, "DELETE")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Delete sub-agent" }));
    expect(await screen.findByText("Sub-agent deleted")).toBeVisible();
    expect(bodies(fetchMock, "DELETE")).toEqual([[path, { expectedVersion: 1 }]]);
  });

  it("keeps the sub-agent on Keep and deletes nothing that changed after the proposal", async () => {
    const kept = card({ action: "delete_proposed", consequences: { threadCount: 0 }, proposalId: "proposal_keep" });
    const fetchMock = respond({ [`GET /api/me/subagents/${kept.definitionId}`]: view(kept.definitionId, 1) });
    render(<ResourceChangeCardsV2 cards={[kept]} />);
    expect(screen.queryByText(/in your chats/u)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep sub-agent" }));
    expect(await screen.findByText("Sub-agent kept")).toBeVisible();
    cleanup();
    const stale = card({ action: "delete_proposed", consequences: { threadCount: 0 }, proposalId: "proposal_stale" });
    const path = `/api/me/subagents/${stale.definitionId}`;
    respond({ [`GET ${path}`]: view(stale.definitionId, 1),
      [`DELETE ${path}`]: new Response(JSON.stringify({ error: "subagent_definition_conflict" }), { status: 409 }) });
    render(<ResourceChangeCardsV2 cards={[stale]} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete sub-agent" }));
    await waitFor(() => expect(screen.getByText("Sub-agent not deleted")).toBeVisible());
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toEqual([]);
  });
});
