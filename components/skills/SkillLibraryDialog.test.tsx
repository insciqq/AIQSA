import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSkillLibraryStoreForTest } from "@/components/app-shell/skillLibraryStore";
import { SkillLibraryDialog } from "./SkillLibraryDialog";

const ownedSkill = {
  archived: false,
  description: "Checks factual claims",
  id: "skill-owned",
  instructions: "Verify every factual claim.",
  name: "Careful editor",
  owned: true,
  ownerDisplayName: "Viewer",
  scope: { kind: "owner" },
  version: 2
};

const sharedSkill = {
  ...ownedSkill,
  description: "Ends with next steps",
  id: "skill-shared",
  instructions: "End with a short action list.",
  name: "Action closer",
  owned: false,
  ownerDisplayName: "Alex",
  scope: { groupNames: ["Design"], kind: "group" },
  version: 1
};

function listResponse(): Response {
  return Response.json({
    publishableGroups: [{ id: "group-1", name: "Design" }],
    skills: [ownedSkill, sharedSkill],
    viewer: { canPublishInstallation: false }
  });
}

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
    expect(screen.getByText("Text-only by design")).toBeVisible();
    expect(screen.getByText(/do not install tools, run code, or start MCP servers/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Use Action closer" }));
    expect(onSelectionChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: "skill-shared" })
    ]);
  });

  it("creates a plain instruction revision without executable fields", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST" ? Response.json({ skill: ownedSkill }, { status: 201 }) : listResponse());
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
});
