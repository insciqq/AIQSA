import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillSuggestions } from "./SkillSuggestions";

const request = { requestId: "00000000-0000-4000-8000-000000000001", draft: "Current work", chatId: null,
  projectId: null, expectedActiveLeafMessageId: null, excludedIds: [] };
const skill = { id: "suggested", name: "Procedure", description: "A useful procedure" };
const props = () => ({ request, excludedIds: [], atLimit: false, onUse: vi.fn(async () => undefined) });
afterEach(() => vi.unstubAllGlobals());

describe("optional Skill suggestions", () => {
  it("has no automatic attachment, dispatches once under StrictMode and accepts only an explicit Use", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ready", skills: [skill] })); vi.stubGlobal("fetch", fetch);
    const input = props();
    const view = render(<StrictMode><div role="dialog"><input type="search" aria-label="Search Skills" /><SkillSuggestions {...input} /></div></StrictMode>);
    input.onUse.mockImplementation(async () => {
      view.rerender(<StrictMode><div role="dialog"><input type="search" aria-label="Search Skills" /><SkillSuggestions {...input} excludedIds={[skill.id]} /></div></StrictMode>);
    });
    const use = await screen.findByRole("button", { name: "Use suggested Procedure" });
    expect(input.onUse).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
    fireEvent.click(use);
    await waitFor(() => expect(input.onUse).toHaveBeenCalledWith(skill.id, expect.any(AbortSignal)));
    await waitFor(() => expect(screen.getByRole("searchbox")).toHaveFocus());
  });
  it("dismisses independently of manual selection and respects live selected IDs and capacity", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ready", skills: [skill] })); vi.stubGlobal("fetch", fetch);
    const input = props(); const { rerender } = render(<SkillSuggestions {...input} atLimit />);
    expect(await screen.findByRole("button", { name: "Use suggested Procedure" })).toBeDisabled();
    rerender(<SkillSuggestions {...input} excludedIds={[skill.id]} />);
    expect(screen.queryByRole("region", { name: "Suggested Skills" })).toBeNull();
    rerender(<SkillSuggestions {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion Procedure" }));
    expect(screen.queryByRole("region", { name: "Suggested Skills" })).toBeNull();
    expect(input.onUse).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["disabled", "ready"])("stays quiet for %s with no recommendations", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status, skills: [] })));
    render(<SkillSuggestions {...props()} />);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Suggested Skills" })).toBeNull());
  });
  it("does not block manual controls on an outage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    render(<><button>Manual selection</button><SkillSuggestions {...props()} /></>);
    expect(await screen.findByRole("status")).toBeVisible();
    await screen.findByText("Suggestions unavailable. You can choose a Skill below.");
    expect(screen.getByRole("button", { name: "Manual selection" })).toBeEnabled();
  });
  it("cannot apply a late recommendation and cancels pending explicit selection when closed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "ready", skills: [skill] })));
    let signal: AbortSignal | undefined;
    const input = props(); input.onUse.mockImplementation(async (_id?: string, value?: AbortSignal) => { signal = value; });
    const view = render(<SkillSuggestions {...input} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use suggested Procedure" }));
    await act(async () => undefined);
    view.unmount(); expect(signal?.aborted).toBe(true);
  });
});
