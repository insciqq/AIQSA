import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSkillLibraryStoreForTest } from "@/components/app-shell/skillLibraryStore";
import { SkillLibraryDialog, SkillLibrarySection } from "./SkillLibraryDialog";

const ownedSkill = {
  archived: false,
  description: "Checks factual claims",
  id: "skill-owned",
  instructionCharacterCount: "Verify every factual claim.".length,
  name: "Careful editor",
  owned: true,
  ownerDisplayName: "Viewer",
  scope: { kind: "owner" },
  updatedAt: "2026-08-16T00:00:00.000Z",
  version: 2
};

const sharedSkill = {
  ...ownedSkill,
  description: "Ends with next steps",
  id: "skill-shared",
  instructionCharacterCount: "End with a short action list.".length,
  name: "Action closer",
  owned: false,
  ownerDisplayName: "Alex",
  scope: { kind: "workspace", workspaceNames: ["Design"] },
  version: 1
};

function listResponse(): Response {
  return Response.json({
    nextCursor: null,
    publishableWorkspaces: [{ id: "group-1", name: "Design" }],
    skills: [ownedSkill, sharedSkill],
    viewer: { canPublishInstallation: false }
  });
}

const ownedSkillDetail = {
  ...ownedSkill,
  assistantUsageCount: 0,
  audiences: [],
  canDelete: true,
  canEdit: true,
  canPublish: true,
  canUnshare: true,
  instructions: "Verify every factual claim.",
  owner: { displayName: "Viewer" },
  workspaceUsageCount: 0
};

const sharedSkillDetail = {
  ...sharedSkill,
  assistantUsageCount: 0,
  audiences: [{ id: "publication-1", kind: "workspace", name: "Design", workspaceId: "group-1" }],
  canDelete: false,
  canEdit: false,
  canPublish: false,
  canUnshare: false,
  instructions: "End with a short action list.",
  owner: { displayName: "Alex" },
  workspaceUsageCount: 1
};

describe("SkillLibraryDialog", () => {
  it("enables all Skills for Auto without changing Always use selections", async () => {
    let enabled = false;
    const onSelectionChange = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/enable-all")) { enabled = true; return Response.json({ enabledCount: 2 }); }
      return Response.json({ ...await listResponse().json(), skills: [ownedSkill, { ...sharedSkill, enabled }] });
    }));
    render(<SkillLibraryDialog selectedIds={[ownedSkill.id]} onSelectionChange={onSelectionChange} onClose={vi.fn()} />);
    const enableAll = await screen.findByRole("button", { name: "Enable all for Auto" });
    await waitFor(() => expect(enableAll).toBeEnabled());
    fireEvent.click(enableAll);
    expect(await screen.findByText("2 Skills are enabled for Auto.")).toBeVisible();
    expect(screen.getByRole("switch", { name: "Auto load: Action closer" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Stop always using Careful editor" })).toHaveAttribute("aria-pressed", "true");
    expect(enableAll).toBeDisabled();
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("changes Enabled independently of pinned selection and keeps the preference in detail", async () => {
    let enabled = false;
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/preference")) {
        writes.push(JSON.parse(String(init?.body)));
        enabled = !enabled;
        return Response.json({ skillId: sharedSkill.id, enabled });
      }
      if (String(input).endsWith("/skill-shared")) return Response.json({ skill: { ...sharedSkillDetail, enabled } });
      return Response.json({ ...await listResponse().json(), skills: [ownedSkill, { ...sharedSkill, enabled }] });
    }));
    const onSelectionChange = vi.fn();
    render(<SkillLibraryDialog selectedIds={[]} onSelectionChange={onSelectionChange} onClose={vi.fn()} />);
    const toggle = await screen.findByRole("switch", { name: "Auto load: Action closer" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Auto load: Action closer" })).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(screen.getByRole("button", { name: "Open Action closer" }));
    const detailToggle = await within(screen.getByRole("region", { name: "Skill detail" })).findByRole("switch", { name: "Auto load: Action closer" });
    expect(detailToggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(detailToggle);
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Skill detail" })).getByRole("switch", { name: "Auto load: Action closer" })).toHaveAttribute("aria-checked", "false"));
    expect(writes).toEqual([{ enabled: true }, { enabled: false }]);
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("requests a specific owner revision, keeps the approved revision visible, and withdraws the exact pending request", async () => {
    const currentRevision = { id: "revision-3", revisionNumber: 3, name: ownedSkill.name, createdAt: ownedSkill.updatedAt };
    let sharing = { currentRevision, sharedRevision: { ...currentRevision, id: "revision-1", revisionNumber: 1 },
      canRequest: true, canWithdraw: false, request: null as null | {
        id: string; revisionId: string; revisionNumber: number; state: string; createdAt: string; reviewedAt: null; reviewNote: null
      } };
    const writes: { method: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/share-requests")) {
        writes.push({ method: init!.method!, body: JSON.parse(String(init!.body)) });
        sharing = init?.method === "POST" ? { ...sharing, canRequest: false, canWithdraw: true,
          request: { id: "request-3", revisionId: "revision-3", revisionNumber: 3, state: "pending", createdAt: ownedSkill.updatedAt, reviewedAt: null, reviewNote: null } }
          : { ...sharing, canRequest: true, canWithdraw: false, request: { ...sharing.request!, state: "withdrawn" } };
        return Response.json({ skill: { ...ownedSkillDetail, sharing } });
      }
      return String(input).endsWith("/skill-owned") ? Response.json({ skill: { ...ownedSkillDetail, sharing } }) : listResponse();
    }));
    render(<SkillLibraryDialog onClose={vi.fn()} onSelectionChange={vi.fn()} selectedIds={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Careful editor" }));
    expect(await screen.findByText("Your version: v3. Approved for sharing: v1.")).toBeVisible();
    expect(screen.getByText("You use your latest version. Other people and Projects continue using the approved version.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Request approval for v3" }));
    expect(await screen.findByText("Awaiting approval · v3")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw request" }));
    expect(await screen.findByText("Withdrawn · v3")).toBeVisible();
    expect(writes).toEqual([{ method: "POST", body: { expectedVersion: 2 } }, { method: "DELETE", body: { requestId: "request-3" } }]);
    expect(screen.getByText("Your version: v3. Approved for sharing: v1.")).toBeVisible();
  });

  it("shows the reviewer note as plain text and preserves a stale request error without claiming success", async () => {
    const revision = { id: "revision-2", revisionNumber: 2, name: ownedSkill.name, createdAt: ownedSkill.updatedAt };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return Response.json({ error: "skill_version_conflict" }, { status: 409 });
      if (String(input).endsWith("/skill-owned")) return Response.json({ skill: { ...ownedSkillDetail,
        sharing: { currentRevision: revision, sharedRevision: null, canRequest: true, canWithdraw: false,
          request: { id: "request-2", revisionId: revision.id, revisionNumber: 2, state: "rejected", createdAt: ownedSkill.updatedAt,
            reviewedAt: ownedSkill.updatedAt, reviewNote: "Remove <script> from the example.\nKeep local assets." } } } });
      return listResponse();
    }));
    render(<SkillLibraryDialog onClose={vi.fn()} onSelectionChange={vi.fn()} selectedIds={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Careful editor" }));
    expect(await screen.findByText(/Remove <script> from the example/)).toBeVisible();
    expect(document.querySelector("script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Request approval for v2" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The Skill changed. Reopen it before requesting approval.");
    expect(screen.queryByText("Approval request submitted.")).toBeNull();
    expect(screen.getByRole("button", { name: "Request approval for v2" })).toBeEnabled();
  });
  it("keeps off-page manual selections removable and enforces the combined Assistant limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => listResponse()));
    const includedSkills = Array.from({ length: 30 }, (_, i) => ({ id: `included-${i}`, name: `Included ${i}` }));
    const input = { includedSkills, onClose: vi.fn(), onSelectionChange: vi.fn(),
      selectedSkills: [{ id: "off-page-a", name: "Off page A" }, { id: "off-page-b", name: "Off page B" }],
      selectedIds: ["off-page-a", "off-page-b"] };
    const { rerender } = render(<SkillLibraryDialog {...input} />);
    expect(await screen.findByRole("button", { name: "Always use Careful editor" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove manual Off page A" }));
    expect(input.onSelectionChange).toHaveBeenCalledWith(["off-page-b"]);
    rerender(<SkillLibraryDialog {...input} selectedIds={["off-page-b"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Always use Careful editor" }));
    expect(input.onSelectionChange).toHaveBeenLastCalledWith(["off-page-b", "skill-owned"]);
  });
  afterEach(() => {
    cleanup();
    resetSkillLibraryStoreForTest();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("preserves a pending page failure through Strict Mode effect replay so it can be retried", async () => {
    vi.useFakeTimers();
    let finishPage: (response: Response) => void = () => undefined;
    let pageRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const cursor = new URL(String(input), "http://localhost").searchParams.get("cursor");
      if (cursor && ++pageRequests === 1) {
        return new Promise<Response>((resolve) => { finishPage = resolve; });
      }
      return Response.json({
        ...await listResponse().json(),
        nextCursor: cursor ? null : "next-page",
        skills: cursor ? [sharedSkill] : [ownedSkill]
      });
    }));
    await act(async () => {
      render(<StrictMode><SkillLibraryDialog onClose={vi.fn()} onSelectionChange={vi.fn()} selectedIds={[]} /></StrictMode>);
    });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load more" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await act(async () => { finishPage(Response.json({ error: "skill_request_failed" }, { status: 503 })); });
    expect(screen.getByRole("alert")).toHaveTextContent("More Skills could not be loaded.");
    expect(screen.getByRole("button", { name: "Always use Careful editor" })).toBeEnabled();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load more" })); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Always use Action closer" })).toBeEnabled();
    expect(pageRequests).toBe(2);
  });

  it("keeps selected metadata and earlier results while a failed search is retried", async () => {
    let searches = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const query = new URL(String(input), "http://localhost").searchParams.get("q");
      if (query === "Action" && ++searches === 1) {
        return Response.json({ error: "skill_request_failed" }, { status: 503 });
      }
      return query === "Action"
        ? Response.json({ ...await listResponse().json(), skills: [sharedSkill] })
        : listResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    const onSelectionChange = vi.fn();
    render(<SkillLibraryDialog onClose={vi.fn()} onSelectionChange={onSelectionChange}
      selectedIds={["off-page"]} selectedSkills={[{ id: "off-page", name: "Earlier workflow" }]} />);

    await screen.findByRole("button", { name: "Always use Careful editor" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Skills" }), { target: { value: "Action" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Skills could not be loaded. Earlier results are shown.");
    expect(screen.getByRole("button", { name: "Always use Careful editor" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove manual Earlier workflow" })).toBeEnabled();
    expect(onSelectionChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Always use Careful editor" })).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(searches).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Always use Action closer" }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(["off-page", "skill-shared"]);
  });

  it("shares the list with the inline Library section without modal chrome", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => listResponse()));
    const onSelectionChange = vi.fn();

    render(
      <SkillLibrarySection
        onSelectionChange={onSelectionChange}
        selectedIds={[]}
      />
    );

    expect(await screen.findByTestId("skill-library-section")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Skills" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Skills" })).toBeVisible();
    expect(screen.getByText(/By Alex · Updated/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Always use Action closer" }));
    expect(onSelectionChange).toHaveBeenCalledWith(["skill-shared"]);
  });

  it("selects an accessible Skill and explains instruction delivery", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => listResponse()));
    const onSelectionChange = vi.fn();

    render(<SkillLibraryDialog
      onClose={vi.fn()}
      onSelectionChange={onSelectionChange}
      selectedIds={[]}
    />);

    await screen.findByText("Action closer");
    expect(screen.getByText("Choose a Skill to inspect")).toBeVisible();
    expect(screen.getByText(/Always use to include it in every message/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Always use Action closer" }));
    expect(onSelectionChange).toHaveBeenCalledWith(["skill-shared"]);
  });

  it("opens a shared Skill as a full preview without selecting the row", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/skill-shared")
        ? Response.json({ skill: sharedSkillDetail })
        : listResponse());
    vi.stubGlobal("fetch", fetchMock);
    const onSelectionChange = vi.fn();

    render(<SkillLibraryDialog
      onClose={vi.fn()}
      onSelectionChange={onSelectionChange}
      selectedIds={[]}
    />);

    await screen.findByText("Action closer");
    fireEvent.click(screen.getByRole("button", { name: "Open Action closer" }));

    expect(await screen.findByText("End with a short action list.")).toBeVisible();
    expect(screen.getByText("By Alex")).toBeVisible();
    expect(screen.getAllByText("Design").some((element) => element.tagName === "SPAN")).toBe(true);
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("creates a plain instruction revision without executable fields", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json({ skill: ownedSkillDetail }, { status: 201 })
        : listResponse());
    vi.stubGlobal("fetch", fetchMock);

    render(<SkillLibraryDialog
      onClose={vi.fn()}
      onSelectionChange={vi.fn()}
      selectedIds={[]}
    />);
    await screen.findByText("Careful editor");
    fireEvent.click(screen.getByRole("button", { name: "New Skill" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Release checklist" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Prepare a release" } });
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "Check tests, migration status, and rollback notes." }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Skill" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      description: "Prepare a release",
      instructions: "Check tests, migration status, and rollback notes.",
      name: "Release checklist"
    });
    expect(screen.queryByLabelText("Instructions")).not.toBeInTheDocument();
  });

  it("keeps editor text and exposes concrete required and UTF-8 size errors", async () => {
    const fetchMock = vi.fn(async () => listResponse());
    vi.stubGlobal("fetch", fetchMock);
    render(<SkillLibraryDialog onClose={vi.fn()} onSelectionChange={vi.fn()} selectedIds={[]} />);
    await screen.findByText("Careful editor");
    fireEvent.click(screen.getByRole("button", { name: "New Skill" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Emoji review" } });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "🙂" } });
    expect(screen.getByText("4 / 131,072 bytes")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Create Skill" }));
    expect(screen.getByRole("alert")).toHaveTextContent("description is required.");
    expect(screen.getByLabelText("Description")).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Review the draft" } });
    const tooLarge = "🙂".repeat(32_769);
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: tooLarge } });
    fireEvent.click(screen.getByRole("button", { name: "Create Skill" }));
    expect(screen.getByRole("alert")).toHaveTextContent("instructions: 131,076 exceeds the limit of 131,072.");
    expect(screen.getByLabelText("Instructions")).toHaveValue(tooLarge);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows each import outcome, skipped files, and the unchanged selection", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
      ? Response.json({ ignoredFiles: 2, results: [
        { name: "New workflow", outcome: "created", skillId: "new" },
        { name: "Careful editor", outcome: "updated", skillId: "skill-owned" },
        { name: "Action closer", outcome: "unchanged", skillId: "skill-shared" },
        { name: "Too long", outcome: "failed", error: { code: "skill_field_too_long", field: "description", actual: 1180, limit: 1024 } }
      ] }) : listResponse());
    vi.stubGlobal("fetch", fetchMock);
    const onSelectionChange = vi.fn();
    render(<SkillLibraryDialog onClose={vi.fn()} onSelectionChange={onSelectionChange} selectedIds={["skill-owned"]} />);
    await screen.findByRole("button", { name: "Open Careful editor" });
    fireEvent.change(screen.getByLabelText("Import Skill file"), { target: { files: [new File(["zip"], "skills.zip")] } });
    const result = await screen.findByRole("status", { name: "Import results" });
    expect(result).toHaveTextContent("1 imported · 1 updated · 1 unchanged · 1 failed");
    expect(result).toHaveTextContent("2 files outside Skill folders skipped.");
    expect(result).toHaveTextContent("description: 1,180 exceeds the limit of 1,024.");
    expect(within(result).getAllByRole("listitem")).toHaveLength(4);
    expect(onSelectionChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss import results" }));
    expect(screen.queryByRole("status", { name: "Import results" })).toBeNull();
  });

  it("previews text files with executable metadata and keeps binary files read-only", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/files?")) return Response.json({ path: "scripts/check.sh", content: "echo reviewed" });
      if (url.endsWith("/skill-owned")) return Response.json({ skill: { ...ownedSkillDetail, files: [
        { path: "scripts/check.sh", kind: "text", executable: true, byteSize: 13 },
        { path: "reference.bin", kind: "binary", executable: false, byteSize: 20 }
      ] } });
      return listResponse();
    }));
    render(<SkillLibraryDialog onClose={vi.fn()} onSelectionChange={vi.fn()} selectedIds={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Careful editor" }));
    fireEvent.click(await screen.findByRole("button", { name: "View scripts/check.sh" }));
    expect(await screen.findByText("echo reviewed")).toBeVisible();
    expect(screen.getByText("13 bytes · Executable")).toBeVisible();
    expect(screen.queryByRole("button", { name: "View reference.bin" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close file preview" }));
    expect(screen.queryByText("echo reviewed")).toBeNull();
  });

  it("shows Delete impact and immediately clears the deleted selection", async () => {
    const impactedDetail = {
      ...ownedSkillDetail,
      assistantUsageCount: 2,
      workspaceUsageCount: 1
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/skill-owned") && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/skill-owned")) return Response.json({ skill: impactedDetail });
      return listResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    const onSelectionChange = vi.fn();

    render(<SkillLibraryDialog
      onClose={vi.fn()}
      onSelectionChange={onSelectionChange}
      selectedIds={["skill-owned", "skill-shared"]}
    />);

    await screen.findByText("Careful editor");
    fireEvent.click(screen.getByRole("button", { name: "Open Careful editor" }));
    await screen.findByText("Verify every factual claim.");
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    expect(screen.getByText(/used by 2 Assistants and shared with 1 Workspace/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Delete Skill" }));

    await waitFor(() => expect(onSelectionChange).toHaveBeenCalledWith(["skill-shared"]));
    expect(fetchMock.mock.calls.some(([input, init]) =>
      String(input).endsWith("/skill-owned") && init?.method === "DELETE")).toBe(true);
    expect(screen.queryByText(/revision|snapshot|binding/i)).not.toBeInTheDocument();
  });

  it("shows current audiences and removes one through explicit Unshare", async () => {
    let unshared = false;
    const publication = {
      id: "publication-design",
      kind: "workspace",
      name: "Design",
      workspaceId: "group-1"
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/publication-design") && init?.method === "DELETE") {
        unshared = true;
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/skill-owned")) {
        return Response.json({
          skill: { ...ownedSkillDetail, audiences: unshared ? [] : [publication] }
        });
      }
      return listResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SkillLibraryDialog
      onClose={vi.fn()}
      onSelectionChange={vi.fn()}
      selectedIds={[]}
    />);

    await screen.findByText("Careful editor");
    fireEvent.click(screen.getByRole("button", { name: "Open Careful editor" }));
    await screen.findByRole("button", { name: "Unshare" });
    expect(screen.getByText("Current audiences")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Unshare" }));

    expect(await screen.findByText("Only you can use this Skill.")).toBeVisible();
    expect(fetchMock.mock.calls.some(([input, init]) =>
      String(input).endsWith("/publication-design") && init?.method === "DELETE")).toBe(true);
  });

  it("restores an archived owned Skill from its detail", async () => {
    let archived = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/skill-owned") && init?.method === "PATCH") {
        archived = false;
        return Response.json({ skill: { ...ownedSkillDetail, archived } });
      }
      if (url.endsWith("/skill-owned")) {
        return Response.json({
          skill: {
            ...ownedSkillDetail,
            archived,
            canEdit: !archived,
            canPublish: !archived
          }
        });
      }
      return Response.json({
        ...await listResponse().json(),
        skills: [{ ...ownedSkill, archived }]
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SkillLibraryDialog
      onClose={vi.fn()}
      onSelectionChange={vi.fn()}
      selectedIds={[]}
    />);

    await screen.findByText("Careful editor");
    fireEvent.click(screen.getByRole("button", { name: "Open Careful editor" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    await screen.findByRole("button", { name: "Edit" });
    expect(fetchMock.mock.calls.some(([input, init]) =>
      String(input).endsWith("/skill-owned") && init?.method === "PATCH" &&
      String(init.body).includes('"archived":false'))).toBe(true);
  });
});
