import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("keeps off-page manual selections removable and enforces the combined Assistant limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => listResponse()));
    const includedSkills = Array.from({ length: 6 }, (_, i) => ({ id: `included-${i}`, name: `Included ${i}` }));
    const input = { includedSkills, onClose: vi.fn(), onSelectionChange: vi.fn(),
      selectedSkills: [{ id: "off-page-a", name: "Off page A" }, { id: "off-page-b", name: "Off page B" }],
      selectedIds: ["off-page-a", "off-page-b"] };
    const { rerender } = render(<SkillLibraryDialog {...input} />);
    expect(await screen.findByRole("button", { name: "Use Careful editor" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove manual Off page A" }));
    expect(input.onSelectionChange).toHaveBeenCalledWith(["off-page-b"]);
    rerender(<SkillLibraryDialog {...input} selectedIds={["off-page-b"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Use Careful editor" }));
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
    expect(screen.getByRole("button", { name: "Use Careful editor" })).toBeEnabled();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load more" })); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use Action closer" })).toBeEnabled();
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

    await screen.findByRole("button", { name: "Use Careful editor" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Skills" }), { target: { value: "Action" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Skills could not be loaded. Earlier results are shown.");
    expect(screen.getByRole("button", { name: "Use Careful editor" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove manual Earlier workflow" })).toBeEnabled();
    expect(onSelectionChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use Careful editor" })).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(searches).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Use Action closer" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Use Action closer" }));
    expect(onSelectionChange).toHaveBeenCalledWith(["skill-shared"]);
  });

  it("selects an accessible Skill and keeps the library text-only", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => listResponse()));
    const onSelectionChange = vi.fn();

    render(<SkillLibraryDialog
      onClose={vi.fn()}
      onSelectionChange={onSelectionChange}
      selectedIds={[]}
    />);

    await screen.findByText("Action closer");
    expect(screen.getByText("Choose a Skill to inspect")).toBeVisible();
    expect(screen.getByText(/do not install tools, run code, or start MCP servers/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Use Action closer" }));
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
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "Check tests, migration status, and rollback notes." }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Skill" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      description: "",
      instructions: "Check tests, migration status, and rollback notes.",
      name: "Release checklist"
    });
    expect(screen.queryByLabelText("Instructions")).not.toBeInTheDocument();
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
