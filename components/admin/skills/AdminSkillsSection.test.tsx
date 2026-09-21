import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminSkillShareRequestDetail } from "@/lib/contracts/adminSkills";
import { AdminSkillsSection } from "./AdminSkillsSection";

vi.mock("@/components/admin/AdminShell", () => ({ useAdminSectionTopbar: vi.fn() }));
const revision = { id: "revision-2", revisionNumber: 2, name: "Review invoices", createdAt: "2026-09-21T00:00:00.000Z" };
const request: AdminSkillShareRequestDetail = {
  id: "request-2", skillId: "skill-1", name: revision.name, ownerDisplayName: "Casey", revisionId: revision.id,
  revisionNumber: 2, state: "pending", createdAt: revision.createdAt, reviewedAt: null, reviewNote: null, canReview: true,
  currentRevision: { ...revision, id: "revision-3", revisionNumber: 3 }, sharedRevision: { ...revision, id: "revision-1", revisionNumber: 1 },
  audiences: [{ id: "audience-1", kind: "workspace", workspaceId: "workspace-1", name: "Accounting" }],
  requestedRevision: { ...revision, description: "Check totals", instructions: "Review the invoice.", skillMarkdown: "---\nname: Review invoices\n---\nReview <script> literally.",
    files: [{ path: "scripts/check.sh", kind: "text", executable: true, byteSize: 12 }, { path: "assets/logo.png", kind: "binary", executable: false, byteSize: 32 }],
    bundle: { fileCount: 2, totalBytes: 100, hasExecutables: true } },
  diff: { skillMarkdownChanged: true, files: [{ path: "scripts/check.sh", kind: "text", executable: true, previousExecutable: false, byteSize: 12, change: "changed" }] }
};
const props = { resource: null, filter: null, onSelectResource: vi.fn(), onSelectFilter: vi.fn(), onMutationCommitted: vi.fn() };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("AdminSkillsSection", () => {
  it("distinguishes failed loading from an empty queue and retries the failed refresh without appending a later page", async () => {
    let attempts = 0;
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return ++attempts === 2 ? Response.json({ error: "temporarily_unavailable" }, { status: 503 })
        : Response.json({ requests: [request], nextCursor: "next-page", pendingCount: 2 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminSkillsSection {...props} />);
    expect(await screen.findByText("2 awaiting approval")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The request could not be completed.");
    expect(screen.queryByText("No pending approval requests.")).toBeNull();
    expect(screen.getByRole("button", { name: "Review Review invoices · v2" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(urls).toEqual(Array(3).fill("/api/admin/skills/requests?state=pending&limit=30"));
    fireEvent.click(screen.getByRole("button", { name: "Review Review invoices · v2" }));
    expect(props.onSelectResource).toHaveBeenCalledWith("request-2");
    fireEvent.change(screen.getByRole("combobox", { name: "Approval status" }), { target: { value: "rejected" } });
    expect(props.onSelectFilter).toHaveBeenCalledWith("rejected");
  });

  it("reviews the requested revision and executable change, previews text safely, and keeps an accepted decision settled if attention refresh fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/files?")) return Response.json({ path: "scripts/check.sh", content: "echo '<script>'" });
      if (init?.method === "POST") return Response.json({ request: { ...request, state: "approved", canReview: false,
        reviewNote: "Reviewed for the team.", reviewedAt: revision.createdAt, sharedRevision: revision } });
      return Response.json({ request });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onMutationCommitted = vi.fn(() => { throw new Error("refresh failed"); });
    render(<AdminSkillsSection {...props} resource="request-2" onMutationCommitted={onMutationCommitted} />);
    expect(await screen.findByText("The owner has a newer revision. This decision applies only to v2.")).toBeVisible();
    expect(screen.getByText("Execution permission added")).toBeVisible();
    expect(screen.getByLabelText("Requested SKILL.md")).toHaveTextContent("Review <script> literally.");
    expect(screen.queryByRole("button", { name: "View assets/logo.png" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View scripts/check.sh" }));
    expect(await screen.findByLabelText("scripts/check.sh")).toHaveTextContent("echo '<script>'");
    expect(document.querySelector("script")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: /Review note/ }), { target: { value: " Reviewed for the team. " } });
    fireEvent.click(screen.getByRole("button", { name: "Approve v2" }));
    expect(await screen.findByText("Revision v2 approved.")).toBeVisible();
    await act(async () => undefined);
    expect(onMutationCommitted).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve v2" })).toBeNull();
    const mutation = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(mutation?.[0]).toBe("/api/admin/skills/requests/request-2");
    expect(JSON.parse(String(mutation?.[1]?.body))).toEqual({ action: "approve", note: "Reviewed for the team." });
  });

  it("preserves the review note on a concurrent decision conflict and blocks notes over the Unicode character limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
      ? Response.json({ error: "skill_share_request_conflict" }, { status: 409 }) : Response.json({ request })));
    render(<AdminSkillsSection {...props} resource="request-2" />);
    const note = await screen.findByRole("textbox", { name: /Review note/ });
    fireEvent.change(note, { target: { value: "📄".repeat(4001) } });
    expect(screen.getByRole("button", { name: "Approve v2" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    fireEvent.change(note, { target: { value: "Please remove the executable permission." } });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This request has changed. Refresh it before trying again.");
    expect(note).toHaveValue("Please remove the executable permission.");
    expect(props.onMutationCommitted).not.toHaveBeenCalled();
  });
});
