import { afterEach, describe, expect, it, vi } from "vitest";
import { resetComposerControlStoreForTest } from "@/tests/support/appShellStores";
import { useComposerControlStore } from "./composerControlStore";
import { loadSkillDetail } from "./skillLibraryStore";
import type { SkillDetail } from "@/lib/contracts/skills";
import { pinSkillForNextTurn } from "./skillPinActions";

vi.mock("./skillLibraryStore", () => ({ loadSkillDetail: vi.fn() }));
const detail = { id: "review", name: "Review", description: "Check claims", instructionCharacterCount: 120,
  instructionApproxTokens: 30, archived: false } as SkillDetail;

describe("Pin a loaded Skill", () => {
  afterEach(() => { resetComposerControlStoreForTest(); vi.resetAllMocks(); });

  it("adds the authorized current Skill to the next turn without changing Off or the draft", async () => {
    vi.mocked(loadSkillDetail).mockResolvedValue(detail);
    useComposerControlStore.getState().setSkillsMode("off");
    await pinSkillForNextTurn({ skillId: "review", isCurrentScope: () => true });
    await pinSkillForNextTurn({ skillId: "review", isCurrentScope: () => true });
    expect(useComposerControlStore.getState()).toMatchObject({ skillsMode: "off", selectedSkills: [
      { id: "review", name: "Review", instructionApproxTokens: 30 }
    ] });
  });

  it("does not add a delayed personal lookup to a newly selected chat", async () => {
    let settle!: (detail: SkillDetail) => void;
    vi.mocked(loadSkillDetail).mockReturnValue(new Promise(resolve => { settle = resolve; }));
    let current = true;
    const pending = pinSkillForNextTurn({ skillId: "review", isCurrentScope: () => current });
    current = false;
    settle(detail);
    await pending;
    expect(useComposerControlStore.getState().selectedSkills).toEqual([]);
  });

  it("uses only the Project catalog and explains missing access", async () => {
    const projectSkills = [{ id: "review", name: "Project review", description: "", promptCharacterCount: 80, available: true }];
    await pinSkillForNextTurn({ skillId: "review", isCurrentScope: () => true, projectSkills });
    expect(useComposerControlStore.getState().selectedSkills[0]?.name).toBe("Project review");
    await expect(pinSkillForNextTurn({ skillId: "private", isCurrentScope: () => true, projectSkills })).rejects.toThrow("no longer available in this Project");
    expect(loadSkillDetail).not.toHaveBeenCalled();
  });

  it("keeps existing pins when access changed or the pinned ceiling was reached", async () => {
    vi.mocked(loadSkillDetail).mockRejectedValueOnce(new Error("not_found")).mockResolvedValue(detail);
    await expect(pinSkillForNextTurn({ skillId: "review", isCurrentScope: () => true })).rejects.toThrow("no longer available");
    useComposerControlStore.getState().setSelectedSkills(Array.from({ length: 32 }, (_, index) => ({
      id: `skill-${index}`, name: `${index}`, description: "", promptCharacterCount: 10
    })));
    await expect(pinSkillForNextTurn({ skillId: "review", isCurrentScope: () => true })).rejects.toThrow("Up to 32 Skills");
    expect(useComposerControlStore.getState().selectedSkills).toHaveLength(32);
  });
});
