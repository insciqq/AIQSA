import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScheduledTaskPinnedSkill } from "@/lib/contracts/scheduledTasks";
import { ScheduledTaskSkillPicker } from "./ScheduledTaskSkillPicker";
import type { ScheduledTaskSkillOption } from "./scheduledTasksApi";

const options: ScheduledTaskSkillOption[] = [
  { id: "skill-digest", name: "gitlab-digest", hasExecutables: true, owned: true, ownerDisplayName: "Me" },
  { id: "skill-style", name: "House style", hasExecutables: false, owned: false, ownerDisplayName: "Ada" },
  { id: "skill-notes", name: "Release notes", hasExecutables: false, owned: true, ownerDisplayName: "Me" },
  { id: "skill-triage", name: "Triage", hasExecutables: false, owned: true, ownerDisplayName: "Me" },
  { id: "skill-extra", name: "Extra", hasExecutables: false, owned: true, ownerDisplayName: "Me" }
];
const pin = (option: ScheduledTaskSkillOption): ScheduledTaskPinnedSkill =>
  ({ id: option.id, name: option.name, available: true, hasExecutables: option.hasExecutables });

function renderPicker(pinned: readonly ScheduledTaskPinnedSkill[], overrides: Partial<Parameters<typeof ScheduledTaskSkillPicker>[0]> = {}) {
  const onChange = vi.fn();
  const loadOptions = overrides.loadOptions ?? vi.fn(async () => options);
  render(<ScheduledTaskSkillPicker disabled={false} loadOptions={loadOptions} onChange={onChange} pinned={pinned}
    workspaceEnabled={false} {...overrides} />);
  return { loadOptions, onChange };
}

describe("ScheduledTaskSkillPicker", () => {
  it("offers the owner's own and shared Skills not pinned yet and adds one as available", async () => {
    const { onChange } = renderPicker([pin(options[1]!)]);
    const select = screen.getByLabelText("Add a Skill");
    await waitFor(() => expect(select).toBeEnabled());
    const offered = within(select).getAllByRole("option").map((option) => option.textContent);
    expect(offered).toEqual(["Add a Skill…", "gitlab-digest · code", "Release notes", "Triage", "Extra"]);
    fireEvent.change(select, { target: { value: "skill-digest" } });
    expect(onChange).toHaveBeenCalledWith([pin(options[1]!), pin(options[0]!)]);
  });

  it("lists pins with a code badge, marks one no longer available and removes either", async () => {
    const gone: ScheduledTaskPinnedSkill = { id: "skill-gone", name: null, available: false, hasExecutables: false };
    const { onChange } = renderPicker([pin(options[0]!), gone]);
    const list = screen.getByRole("list", { name: "Pinned Skills" });
    const [digest, lost] = within(list).getAllByRole("listitem");
    expect(within(digest!).getByText("code")).toBeInTheDocument();
    expect(lost).toHaveTextContent("Unavailable Skill");
    expect(lost).toHaveTextContent("No longer available");
    fireEvent.click(within(lost!).getByRole("button", { name: "Remove Unavailable Skill" }));
    expect(onChange).toHaveBeenLastCalledWith([pin(options[0]!)]);
    fireEvent.click(screen.getByRole("button", { name: "Remove gitlab-digest" }));
    expect(onChange).toHaveBeenLastCalledWith([gone]);
  });

  it("says scripts need Workspace while it is off, and nothing once it is on", async () => {
    renderPicker([pin(options[0]!)]);
    expect(screen.getByTestId("scheduled-task-skill-scripts"))
      .toHaveTextContent("“gitlab-digest” has scripts, which run only with Workspace on.");
    await waitFor(() => expect(screen.getByLabelText("Add a Skill")).toBeEnabled());
  });

  it("stops at four pins", async () => {
    renderPicker(options.slice(0, 4).map(pin), { workspaceEnabled: true });
    expect(screen.queryByTestId("scheduled-task-skill-scripts")).toBeNull();
    const select = screen.getByLabelText("Add a Skill");
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(2));
    expect(select).toBeDisabled();
    expect(within(select).getAllByRole("option")[0]).toHaveTextContent("Up to 4 Skills");
  });

  it("shows a load failure with a retry and the server's refusal", async () => {
    const loadOptions = vi.fn<() => Promise<readonly ScheduledTaskSkillOption[]>>()
      .mockRejectedValueOnce(new Error("offline")).mockResolvedValue(options);
    renderPicker([], { error: "A pinned Skill is not available to you. Remove it or choose another Skill.", loadOptions });
    expect(screen.getByRole("alert")).toHaveTextContent("A pinned Skill is not available to you.");
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByLabelText("Add a Skill")).toBeEnabled());
    expect(loadOptions).toHaveBeenCalledTimes(2);
  });
});
