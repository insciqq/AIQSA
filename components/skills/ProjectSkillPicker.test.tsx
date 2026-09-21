import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectSkillPicker } from "./ProjectSkillPicker";

const available = { id: "project-skill", name: "Project checklist", description: "A shared workflow", available: true };
const props = () => ({ resources: [available], includedSkills: [], selectedSkills: [], state: "ready" as const,
  onClose: vi.fn(), onRetry: vi.fn(), onSelectionChange: vi.fn() });
afterEach(() => vi.unstubAllGlobals());

describe("Project Skill selection", () => {
  it("uses Project revision estimates for Assistant and manual pins without counting On demand twice", () => {
    render(<ProjectSkillPicker {...props()} resources={[
      { ...available, instructionApproxTokens: 200 },
      { ...available, id: "manual", name: "Manual", instructionApproxTokens: 51 }
    ]} includedSkills={[{ id: available.id, name: available.name }, { id: "manual", name: "Manual", mode: "available" }]}
      selectedSkills={[{ id: available.id, name: available.name }, { id: "manual", name: "Manual" }]}
      modelContextWindow={1000} availableCount={0} />);
    expect(screen.getByText("2 always included · ≈251 instruction tokens · 25.1% of model window")).toBeVisible();
    expect(screen.getByText("Assistant: ≈200 · Yours: ≈51")).toBeVisible();
    expect(screen.getByText("0 skills available on demand")).toBeVisible();
  });

  it("selects only the supplied Project catalog without personal-library requests", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const input = props();
    const { rerender } = render(<ProjectSkillPicker {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "Always use Project checklist" }));
    expect(input.onSelectionChange).toHaveBeenCalledWith([available.id]);
    rerender(<ProjectSkillPicker {...input} selectedSkills={[available]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove manual Project checklist" }));
    expect(input.onSelectionChange).toHaveBeenLastCalledWith([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("distinguishes empty, unavailable, failed and loading states and prevents revoked additions", () => {
    const input = props();
    const { rerender } = render(<ProjectSkillPicker {...input} resources={[]} />);
    expect(screen.getByText("No Skills have been shared with this Project.")).toBeVisible();
    rerender(<ProjectSkillPicker {...input} resources={[{ ...available, available: false }]} />);
    expect(screen.getByRole("button", { name: "Always use Project checklist" })).toBeDisabled();
    rerender(<ProjectSkillPicker {...input} state="error" />);
    expect(screen.queryByRole("button", { name: "Always use Project checklist" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(input.onRetry).toHaveBeenCalledOnce();
    rerender(<ProjectSkillPicker {...input} state="loading" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading Project Skills");
    rerender(<ProjectSkillPicker {...input} state="unavailable" />);
    expect(screen.getByRole("alert")).toHaveTextContent("no longer available");
  });

  it("counts Assistant overlap once and releases capacity after manual removal", () => {
    const included = Array.from({ length: 30 }, (_, i) => ({ ...available, id: `included-${i}`, name: `Included ${i}` }));
    const input = { ...props(), includedSkills: included, resources: [included[0]!, available],
      selectedSkills: [included[0]!, { id: "manual-a", name: "Manual A" }, { id: "manual-b", name: "Manual B" }] };
    const { rerender } = render(<ProjectSkillPicker {...input} />);
    expect(screen.getByText(/^32 always included ·/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Always use Project checklist" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Always included Included 0" })).toBeDisabled();
    rerender(<ProjectSkillPicker {...input} selectedSkills={input.selectedSkills.slice(0, 2)} />);
    fireEvent.click(screen.getByRole("button", { name: "Always use Project checklist" }));
    expect(input.onSelectionChange).toHaveBeenCalledWith(["included-0", "manual-a", available.id]);
  });

  it("owns Escape and restores a reachable opener", async () => {
    const input = props();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(<ProjectSkillPicker {...input} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Close Skills" })).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(input.onClose).toHaveBeenCalledOnce();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
