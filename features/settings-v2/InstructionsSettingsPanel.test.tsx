import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InstructionsSettingsPanel } from "./InstructionsSettingsPanel";
import type { InstructionPreview } from "@/lib/contracts/instructionPreview";
import { InstructionPresetApiError, requestInstructionPreset, requestInstructionPresets, requestInstructionPreview } from "./instructionPresetsApi";

vi.mock("./instructionPresetsApi", async importOriginal => ({ ...await importOriginal<typeof import("./instructionPresetsApi")>(),
  requestInstructionPreset: vi.fn(), requestInstructionPresets: vi.fn(), requestInstructionPreview: vi.fn() }));
const request = vi.mocked(requestInstructionPresets), detail = vi.mocked(requestInstructionPreset), preview = vi.mocked(requestInstructionPreview);
const preset = { id: "preset", name: "Work", revision: 1, updatedAt: "2026-09-15T10:00:00.000Z", systemInstructions: "Saved instructions", responseReminder: "Answer in Spanish" };
const state = { activePresetId: "preset", selectionVersion: 1, presets: [{ id: preset.id, name: preset.name, revision: 1, updatedAt: preset.updatedAt, firstLine: preset.systemInstructions }] };
const platformPreview: InstructionPreview = {
  baseline: { renderedSystemPrompt: "You are helpful. Today is June 7, 2026, local time is 02:34 PM GMT+2.", timeZone: "Europe/Berlin", timeZoneSource: "client" },
  generatedAt: "2026-06-07T12:34:00.000Z",
  visibleAnswerContract: "Answer directly without debug sections."
};
async function manage() {
  render(<InstructionsSettingsPanel />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Active instructions" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Manage presets…" }));
}
beforeEach(() => { request.mockReset().mockResolvedValue(state); detail.mockReset().mockResolvedValue(preset); preview.mockReset().mockResolvedValue(platformPreview); });
describe("instruction preset editor", () => {
  it("activates preset rows and the built-in default through the same versioned selection", async () => {
    await manage();
    expect(screen.queryByRole("button", { name: "Make active: Work" })).toBeNull();
    request.mockResolvedValueOnce({ ...state, activePresetId: null, selectionVersion: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Make active: AIQSA default instructions" }));
    await waitFor(() => expect(screen.getByLabelText("Active instructions: AIQSA default instructions")).toHaveFocus());
    expect(screen.getByRole("button", { name: "Active instructions" })).toHaveTextContent("AIQSA default instructions");
    expect(request).toHaveBeenLastCalledWith({ action: "select", id: null, selectionVersion: 1 });

    request.mockResolvedValueOnce({ ...state, selectionVersion: 3 });
    fireEvent.click(screen.getByRole("button", { name: "Make active: Work" }));
    await waitFor(() => expect(screen.getByLabelText("Active instructions: Work")).toHaveFocus());
    expect(screen.getByRole("button", { name: "Active instructions" })).toHaveTextContent("Work");
    expect(request).toHaveBeenLastCalledWith({ action: "select", id: "preset", selectionVersion: 2 });
    expect(screen.queryByRole("button", { name: "Make active: Work" })).toBeNull();
  });

  it("blocks duplicate activation while selection is pending", async () => {
    await manage();
    let resolve!: (value: typeof state) => void;
    request.mockImplementationOnce(() => new Promise(settle => { resolve = settle; }));
    const activate = screen.getByRole("button", { name: "Make active: AIQSA default instructions" });
    fireEvent.click(activate);
    expect(activate).toBeDisabled();
    expect(screen.getByRole("button", { name: "Active instructions" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit Work" })).toBeDisabled();
    fireEvent.click(activate);
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => resolve(state));
    expect(activate).toBeEnabled();
  });

  it.each([new Error("offline"), new InstructionPresetApiError("instruction_preset_conflict")])(
    "preserves the active preset after a failed row selection and retries with reloaded authority: %s", async (failure) => {
      await manage();
      request.mockRejectedValueOnce(failure);
      fireEvent.click(screen.getByRole("button", { name: "Make active: AIQSA default instructions" }));
      await screen.findByRole("alert");
      expect(screen.getByLabelText("Active instructions: Work")).toBeVisible();
      expect(screen.queryByLabelText("Active instructions: AIQSA default instructions")).toBeNull();
      expect(screen.getByRole("button", { name: "Active instructions" })).toHaveTextContent("Work");
      request.mockResolvedValueOnce({ ...state, selectionVersion: 5 });
      fireEvent.click(screen.getByRole("button", { name: "Reload presets" }));
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      await waitFor(() => expect(screen.getByRole("button", { name: "Make active: AIQSA default instructions" })).toBeEnabled());
      request.mockResolvedValueOnce({ ...state, activePresetId: null, selectionVersion: 6 });
      fireEvent.click(screen.getByRole("button", { name: "Make active: AIQSA default instructions" }));
      await screen.findByLabelText("Active instructions: AIQSA default instructions");
      expect(request).toHaveBeenLastCalledWith({ action: "select", id: null, selectionVersion: 5 });
    }
  );

  it("preserves the draft after a conflict and after loading the newer saved version", async () => {
    await manage(); fireEvent.click(screen.getByRole("button", { name: "Edit Work" }));
    const text = await screen.findByLabelText("System instructions");
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveFocus());
    fireEvent.change(text, { target: { value: "Unsaved draft" } });
    request.mockRejectedValueOnce(new InstructionPresetApiError("instruction_preset_conflict"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/changed elsewhere/); expect(text).toHaveValue("Unsaved draft");
    detail.mockResolvedValueOnce({ ...preset, revision: 2, systemInstructions: "New remote version" });
    fireEvent.click(screen.getByRole("button", { name: "Reload latest version" }));
    await screen.findByText(/Latest version loaded/); expect(text).toHaveValue("Unsaved draft");
    fireEvent.click(screen.getByText("Latest saved version: Work"));
    fireEvent.click(screen.getByRole("button", { name: "Replace draft with latest version" }));
    expect(text).toHaveValue("New remote version");
  });
  it("previews inert Markdown and saves literal text with Ctrl+S", async () => {
    await manage(); fireEvent.click(screen.getByRole("button", { name: "New preset" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Writing" } });
    const content = "# Style\nUse **short** replies. [external](https://example.com) <script>bad()</script>";
    fireEvent.change(screen.getByLabelText("System instructions"), { target: { value: content } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Preview" })); });
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Style" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "external" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("form", { name: "New instruction preset" }), { key: "s", ctrlKey: true });
    await screen.findByText(/Preset saved/);
    expect(request).toHaveBeenLastCalledWith({ action: "create", value: { name: "Writing", systemInstructions: content, responseReminder: "" } });
    expect(request).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Active instructions: Work")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "New preset" })).toHaveFocus());
  });
  it("confirms active deletion and explicitly selects the default", async () => {
    await manage(); fireEvent.click(screen.getByRole("button", { name: "Delete Work" }));
    expect(screen.getByText(/Your chats will use the AIQSA default instructions/)).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Keep preset" }));
    fireEvent.click(screen.getByRole("button", { name: "Active instructions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "AIQSA default instructions" }));
    await waitFor(() => expect(request).toHaveBeenLastCalledWith({ action: "select", id: null, selectionVersion: 1 }));
  });

  it("toggles the preset disclosure with stable aria state and restores trigger focus", async () => {
    await manage();
    const trigger = screen.getByRole("button", { name: "Manage presets…" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const panelId = trigger.getAttribute("aria-controls")!;
    expect(document.getElementById(panelId)).toBeVisible();

    screen.getByRole("button", { name: "Done" }).focus();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("heading", { name: "Instruction presets" })).toBeNull();
    expect(trigger).toHaveFocus();
    expect(request).toHaveBeenCalledTimes(1);

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", panelId);
    expect(screen.getByRole("heading", { name: "Instruction presets" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(trigger).toHaveFocus();
    expect(document.getElementById(panelId)).not.toBeVisible();
  });

  it("guards a dirty editor when the trigger requests close", async () => {
    await manage();
    fireEvent.click(screen.getByRole("button", { name: "Edit Work" }));
    const text = await screen.findByLabelText("System instructions");
    fireEvent.change(text, { target: { value: "Unsaved" } });

    const trigger = screen.getByRole("button", { name: "Manage presets…" });
    fireEvent.click(trigger);
    expect(screen.getByText("Discard your unsaved instructions?")).toBeInTheDocument();
    expect(screen.getByLabelText("System instructions")).toHaveValue("Unsaved");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveFocus());
    expect(screen.getByLabelText("System instructions")).toHaveValue("Unsaved");

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
    expect(screen.queryByLabelText("System instructions")).toBeNull();
    expect(trigger).toHaveFocus();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("closes a clean editor without leaving an invisible draft", async () => {
    await manage();
    fireEvent.click(screen.getByRole("button", { name: "Edit Work" }));
    await screen.findByLabelText("System instructions");
    const trigger = screen.getByRole("button", { name: "Manage presets…" });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    expect(screen.getByRole("heading", { name: "Instruction presets" })).toBeInTheDocument();
    expect(screen.queryByLabelText("System instructions")).toBeNull();
  });

  it.each([null, "preset"])("loads the read-only platform preview without changing selection: %s", async activePresetId => {
    request.mockResolvedValueOnce({ ...state, activePresetId });
    await manage();
    fireEvent.click(screen.getByRole("button", { name: "View instructions" }));
    expect(await screen.findByText(/June 7, 2026/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "AIQSA default instructions" })).toHaveFocus();
    expect(document.querySelector("time")).toHaveAttribute("datetime", platformPreview.generatedAt);
    expect(screen.getByText(/Time zone used: Europe\/Berlin/)).toBeInTheDocument();
    expect(screen.getByText("Answer directly without debug sections.")).toBeInTheDocument();
    expect(preview).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(screen.queryByRole("region", { name: "AIQSA default instructions preview" })).toBeNull();
    expect(screen.getByRole("button", { name: "View instructions" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Active instructions" })).toHaveTextContent(activePresetId ? "Work" : "AIQSA default instructions");
  });

  it("can close a loading preview and ignores its late response", async () => {
    await manage();
    let resolve!: (value: InstructionPreview) => void;
    preview.mockImplementationOnce(() => new Promise(settle => { resolve = settle; }));
    fireEvent.click(screen.getByRole("button", { name: "View instructions" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading built-in instructions");
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(screen.queryByRole("region", { name: "AIQSA default instructions preview" })).toBeNull();
    expect(preview.mock.calls[0][1]?.aborted).toBe(true);
    await act(async () => resolve({ ...platformPreview, visibleAnswerContract: "late" }));
    expect(screen.queryByText("late")).toBeNull();
  });

  it("retries preview failure and can collapse the whole panel without changing presets", async () => {
    await manage();
    preview.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "View instructions" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("built-in instructions are unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(platformPreview.visibleAnswerContract);
    expect(preview).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Manage presets…" }));
    expect(screen.getByRole("button", { name: "Manage presets…" })).toHaveFocus();
    expect(screen.queryByRole("region", { name: "AIQSA default instructions preview" })).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
