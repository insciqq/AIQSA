import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSkillLibraryStoreForTest } from "@/components/app-shell/skillLibraryStore";
import { SkillLibraryDialog } from "./SkillLibraryDialog";

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
  afterEach(() => {
    cleanup();
    resetSkillLibraryStoreForTest();
    vi.unstubAllGlobals();
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
