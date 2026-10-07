import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSkillLibraryStoreForTest } from "@/components/app-shell/skillLibraryStore";
import type { SkillVersionSummary, SkillVersionsResponse } from "@/lib/contracts/skillVersions";
import { SkillVersionsSection } from "./SkillVersionsSection";

const version = (revisionNumber: number, extra: Partial<SkillVersionSummary> = {}): SkillVersionSummary => ({
  revisionId: `rev-${revisionNumber}`, revisionNumber, createdAt: `2026-10-0${Math.min(revisionNumber, 9)}T08:00:00.000Z`,
  authorDisplayName: "Ada", fileCount: 2, byteSize: 2_048, hasExecutables: false, current: false, shared: false, changeNote: null,
  restoredFrom: null, ...extra
});
const page = (versions: SkillVersionsResponse["versions"], extra: Partial<SkillVersionsResponse> = {}): SkillVersionsResponse => ({
  skillId: "skill-1", version: 4, archived: false, nextBefore: null, versions, ...extra
});
const history = page([version(4, { current: true, changeNote: "Broke the digest", hasExecutables: true }), version(3, { shared: true }),
  version(2, { restoredFrom: 1 }), version(1)]);
const LIST = "GET /api/me/skills/skill-1/revisions";
const RESTORE = "POST /api/me/skills/skill-1/revisions/rev-3/restore";

function respond(routes: Record<string, unknown | ((init?: RequestInit) => Response)>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const match = Object.entries(routes).find(([route]) => key === route);
    if (!match) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    const body = match[1];
    if (typeof body === "function") return (body as (init?: RequestInit) => Response)(init);
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderSection(input: Readonly<{ published?: boolean; version?: number }> = {}) {
  const onChanged = vi.fn();
  const view = render(<SkillVersionsSection skill={{ id: "skill-1", name: "gitlab-digest", version: input.version ?? 4 }}
    published={input.published ?? false} onChanged={onChanged} />);
  return { ...view, onChanged };
}

afterEach(() => {
  cleanup();
  resetSkillLibraryStoreForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SkillVersionsSection", () => {
  it("lists versions newest first with current, shared, notes and restore sources", async () => {
    respond({ [LIST]: history });
    renderSection();
    const list = await screen.findByRole("list", { name: "Versions of gitlab-digest" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(["v4", "v3", "v2", "v1"]);
    expect(rows[0]).toHaveTextContent("Current");
    expect(rows[0]).toHaveTextContent("2 files · 2 KB · Runs scripts");
    expect(rows[0]).toHaveTextContent("Broke the digest");
    expect(rows[1]).toHaveTextContent("Shared");
    expect(rows[2]).toHaveTextContent("Restored from v1");
    // The current version has nothing to restore.
    expect(within(rows[0]!).queryByRole("button", { name: /Restore/u })).toBeNull();
    expect(within(rows[1]!).getByRole("button", { name: "Restore v3" })).toBeEnabled();
  });

  it("asks for a confirmation that names the version, then restores with the listed version", async () => {
    const fetchMock = respond({ [LIST]: history, [RESTORE]: { outcome: "restored", version: 5, revisionNumber: 5, restoredFrom: 3 },
      "GET /api/me/skills?": { skills: [], nextCursor: null, publishableWorkspaces: [], viewer: { canPublishInstallation: false } } });
    const { onChanged } = renderSection({ published: true });
    fireEvent.click(await screen.findByRole("button", { name: "Restore v3" }));
    const confirmation = screen.getByRole("group", { name: "Restore v3" });
    expect(confirmation).toHaveTextContent("Restore v3 of “gitlab-digest”?");
    expect(confirmation).toHaveTextContent("Colleagues keep the shared version until you share again.");
    expect(within(confirmation).getByRole("button", { name: "Cancel" })).toHaveFocus();
    // Nothing is written before the confirmation.
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    fireEvent.click(within(confirmation).getByRole("button", { name: "Restore v3" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("v3 restored as v5."));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ expectedVersion: 4 });
    expect(onChanged).toHaveBeenCalledOnce();
    expect(screen.queryByRole("group", { name: "Restore v3" })).toBeNull();
  });

  it("cancels without writing", async () => {
    const fetchMock = respond({ [LIST]: history });
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Restore v3" }));
    expect(screen.getByRole("group", { name: "Restore v3" })).not.toHaveTextContent("Colleagues keep");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Restore v3" })).toBeNull();
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("reports a concurrent change as a conflict, reloads the list and the detail, and writes nothing", async () => {
    let lists = 0;
    respond({ [LIST]: () => { lists += 1; return new Response(JSON.stringify(history)); },
      [RESTORE]: new Response(JSON.stringify({ error: "skill_version_conflict" }), { status: 409 }) });
    const { onChanged } = renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Restore v3" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Restore v3" })).getByRole("button", { name: "Restore v3" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The Skill changed after this list was loaded, so v3 was not restored.");
    await waitFor(() => expect(lists).toBe(2));
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("reports failures, unchanged content and archived Skills", async () => {
    respond({ [LIST]: history, [RESTORE]: new Response(JSON.stringify({ error: "skill_operation_failed" }), { status: 503 }) });
    const { onChanged } = renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Restore v3" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Restore v3" })).getByRole("button", { name: "Restore v3" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("v3 could not be restored. Try again.");
    expect(onChanged).not.toHaveBeenCalled();
    cleanup();

    respond({ [LIST]: history, [RESTORE]: { outcome: "unchanged", version: 4 } });
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Restore v3" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Restore v3" })).getByRole("button", { name: "Restore v3" }));
    expect(await screen.findByRole("status")).toHaveTextContent("v3 already matches the current version; nothing changed.");
    cleanup();

    respond({ [LIST]: page(history.versions, { archived: true }) });
    renderSection();
    expect(await screen.findByRole("button", { name: "Restore v3" })).toBeDisabled();
    expect(screen.getByText(/Restore the Skill from the archive to restore a version/u)).toBeVisible();
  });

  it("offers a retry when the list fails and pages older versions", async () => {
    let fail = true;
    respond({ [LIST]: () => fail ? new Response("{}", { status: 503 }) : new Response(JSON.stringify(page(
      Array.from({ length: 30 }, (_, index) => version(40 - index, { current: index === 0 })), { nextBefore: 11 }))),
    [`${LIST}?before=11`]: page([version(10), version(9)]) });
    renderSection();
    expect(await screen.findByText("Versions could not be loaded.")).toBeVisible();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    const list = await screen.findByRole("list", { name: "Versions of gitlab-digest" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Show 25 more" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(30);
    fireEvent.click(screen.getByRole("button", { name: "Load older versions" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(32));
    expect(screen.queryByRole("button", { name: "Load older versions" })).toBeNull();
  });
});
