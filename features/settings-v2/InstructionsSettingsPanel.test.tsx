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
  await waitFor(() => expect(screen.getByRole("radio", { name: "Work" })).toBeEnabled());
}
beforeEach(() => { request.mockReset().mockResolvedValue(state); detail.mockReset().mockResolvedValue(preset); preview.mockReset().mockResolvedValue(platformPreview); });
describe("instruction preset editor", () => {
  it("shows shared rules, edits a private override and resets it without changing instruction text", async () => {
    await manage();
    expect(screen.getByText("AIQSA standard answer rules")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Edit Work" }));
    await screen.findByLabelText("System instructions");
    fireEvent.click(screen.getByText("Answer rules · AIQSA standard"));
    fireEvent.click(screen.getByRole("button", { name: "Customize answer rules" }));
    const rules = screen.getByLabelText("Answer rules");
    expect(rules).toHaveFocus();
    expect((rules as HTMLTextAreaElement).value).toContain("Visible answer contract");
    fireEvent.change(rules, { target: { value: "Write three numbered paragraphs." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Preset saved/);
    expect(request).toHaveBeenLastCalledWith({ action: "update", id: "preset", revision: 1,
      value: { name: "Work", systemInstructions: preset.systemInstructions, responseReminder: preset.responseReminder, answerRules: "Write three numbered paragraphs." } });
    detail.mockResolvedValueOnce({ ...preset, revision: 2, answerRules: "Write three numbered paragraphs." });
    fireEvent.click(screen.getByRole("button", { name: "Edit Work" }));
    await screen.findByLabelText("System instructions");
    fireEvent.click(screen.getByText("Answer rules · Custom"));
    fireEvent.click(screen.getByRole("button", { name: "Use standard answer rules" }));
    expect(screen.getByRole("button", { name: "Customize answer rules" })).toHaveFocus();
    expect(screen.getByLabelText("System instructions")).toHaveValue(preset.systemInstructions);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Preset saved/);
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 2, value: expect.objectContaining({ answerRules: null }) }));
  });
  it("activates preset rows and the built-in default through the same versioned selection", async () => {
    await manage();
    expect(screen.getByRole("radio", { name: "Work" })).toBeChecked();
    request.mockResolvedValueOnce({ ...state, activePresetId: null, selectionVersion: 2 });
    fireEvent.click(screen.getByRole("radio", { name: "AIQSA default instructions" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "AIQSA default instructions" })).toHaveFocus());
    expect(screen.getByRole("radio", { name: "AIQSA default instructions" })).toBeChecked();
    expect(request).toHaveBeenLastCalledWith({ action: "select", id: null, selectionVersion: 1 });

    request.mockResolvedValueOnce({ ...state, selectionVersion: 3 });
    fireEvent.click(screen.getByRole("radio", { name: "Work" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Work" })).toHaveFocus());
    expect(screen.getByRole("radio", { name: "Work" })).toBeChecked();
    expect(request).toHaveBeenLastCalledWith({ action: "select", id: "preset", selectionVersion: 2 });
    expect(screen.getByRole("radio", { name: "Work" })).toBeChecked();
  });

  it("blocks duplicate activation while selection is pending", async () => {
    await manage();
    let resolve!: (value: typeof state) => void;
    request.mockImplementationOnce(() => new Promise(settle => { resolve = settle; }));
    const activate = screen.getByRole("radio", { name: "AIQSA default instructions" });
    fireEvent.click(activate);
    expect(activate).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Work" })).toBeDisabled();
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
      fireEvent.click(screen.getByRole("radio", { name: "AIQSA default instructions" }));
      await screen.findByRole("alert");
      expect(screen.getByLabelText("Active instructions: Work")).toBeVisible();
      expect(screen.queryByLabelText("Active instructions: AIQSA default instructions")).toBeNull();
      expect(screen.getByRole("radio", { name: "Work" })).toBeChecked();
      request.mockResolvedValueOnce({ ...state, selectionVersion: 5 });
      fireEvent.click(screen.getByRole("button", { name: "Reload presets" }));
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      await waitFor(() => expect(screen.getByRole("radio", { name: "AIQSA default instructions" })).toBeEnabled());
      request.mockResolvedValueOnce({ ...state, activePresetId: null, selectionVersion: 6 });
      fireEvent.click(screen.getByRole("radio", { name: "AIQSA default instructions" }));
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
    await act(async () => { fireEvent.click(screen.getByRole("radio", { name: "Preview" })); });
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Style" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "external" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("form", { name: "New instruction preset" }), { key: "s", ctrlKey: true });
    await screen.findByText(/Preset saved/);
    expect(request).toHaveBeenLastCalledWith({ action: "create", value: { name: "Writing", systemInstructions: content, responseReminder: "", answerRules: null } });
    expect(request).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Active instructions: Work")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "New preset" })).toHaveFocus());
  });
  it("confirms active deletion and explicitly selects the default", async () => {
    await manage(); fireEvent.click(screen.getByRole("button", { name: "More actions for Work" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByText(/Your chats will use the AIQSA default instructions/)).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Keep preset" }));
    fireEvent.click(screen.getByRole("radio", { name: "AIQSA default instructions" }));
    await waitFor(() => expect(request).toHaveBeenLastCalledWith({ action: "select", id: null, selectionVersion: 1 }));
  });

  it("shows the list immediately and does not resubmit the active choice", async () => {
    await manage();
    expect(screen.getByRole("radiogroup", { name: "Active instructions" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Manage presets…" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Work" }));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps a dirty editor until Cancel is explicitly confirmed and restores its row", async () => {
    await manage();
    fireEvent.click(screen.getByRole("button", { name: "Edit Work" }));
    const text = await screen.findByLabelText("System instructions");
    fireEvent.change(text, { target: { value: "Unsaved" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Discard your unsaved instructions?")).toBeVisible();
    expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Name")).toHaveFocus();
    expect(text).toHaveValue("Unsaved");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByLabelText("System instructions")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit Work" })).toHaveFocus();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("closes a pristine editor immediately and opens its nonempty reminder", async () => {
    await manage();
    fireEvent.click(screen.getByRole("button", { name: "Edit Work" }));
    await screen.findByLabelText("System instructions");
    expect(screen.getByLabelText("Response reminder")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByLabelText("System instructions")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit Work" })).toHaveFocus();
  });

  it("explains the count limit and prevents both creating and duplicating", async () => {
    request.mockResolvedValueOnce({ ...state, presets: Array.from({ length: 20 }, (_, index) => ({ ...state.presets[0], id: index ? `preset-${index}` : "preset", name: index ? `Work ${index}` : "Work" })) });
    await manage();
    expect(screen.getByRole("button", { name: "New preset" })).toBeDisabled();
    expect(screen.getByText("You can save up to 20 presets.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "More actions for Work" }));
    expect(screen.getByRole("menuitem", { name: "Duplicate" })).toBeDisabled();
  });

  it("duplicates into a draft without mutating the original or active selection", async () => {
    await manage();
    fireEvent.click(screen.getByRole("button", { name: "More actions for Work" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    expect(await screen.findByLabelText("Name")).toHaveValue("Work copy");
    expect(screen.getByLabelText("System instructions")).toHaveValue(preset.systemInstructions);
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Preset saved/);
    expect(request).toHaveBeenLastCalledWith({ action: "create", value: { name: "Work copy", systemInstructions: preset.systemInstructions, responseReminder: preset.responseReminder, answerRules: null } });
    expect(screen.getByRole("button", { name: "Edit Work" })).toHaveFocus();
  });

  it("reports subview/busy state and delegates Cancel to the shared exit guard", async () => {
    const onSubviewChange = vi.fn(), onRequestExit = vi.fn(), onBusyChange = vi.fn();
    render(<InstructionsSettingsPanel onSubviewChange={onSubviewChange} onRequestExit={onRequestExit} onBusyChange={onBusyChange} />);
    await screen.findByRole("radio", { name: "Work" });
    fireEvent.click(screen.getByRole("button", { name: "Edit Work" }));
    const name = await screen.findByLabelText("Name");
    fireEvent.change(name, { target: { value: "Draft name" } });
    expect(onSubviewChange).toHaveBeenLastCalledWith(expect.objectContaining({ backLabel: "Back to Instructions", label: "Draft name", focus: "resource", busy: false }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onRequestExit).toHaveBeenCalledTimes(1);
    expect(name).toHaveValue("Draft name");
    fireEvent.keyDown(name, { key: "s", ctrlKey: true, isComposing: true });
    expect(request).toHaveBeenCalledTimes(1);
    let settle!: (value: typeof state) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    expect(onSubviewChange).toHaveBeenLastCalledWith(expect.objectContaining({ busy: true }));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("form"), { key: "s", metaKey: true });
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => settle(state));
    expect(onSubviewChange).toHaveBeenLastCalledWith(null);
  });

  it.each([null, "preset"])("loads the read-only platform preview without changing selection: %s", async activePresetId => {
    request.mockResolvedValueOnce({ ...state, activePresetId });
    await manage();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(await screen.findByText(/June 7, 2026/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "AIQSA default instructions" })).toHaveFocus();
    expect(document.querySelector("time")).toHaveAttribute("datetime", platformPreview.generatedAt);
    expect(screen.getByText(/Time zone used: Europe\/Berlin/)).toBeInTheDocument();
    expect(screen.getByText("Answer directly without debug sections.")).toBeInTheDocument();
    expect(preview).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(screen.queryByRole("region", { name: "AIQSA default instructions preview" })).toBeNull();
    expect(screen.getByRole("button", { name: "View" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: activePresetId ? "Work" : "AIQSA default instructions" })).toBeChecked();
  });

  it("can close a loading preview and ignores its late response", async () => {
    await manage();
    let resolve!: (value: InstructionPreview) => void;
    preview.mockImplementationOnce(() => new Promise(settle => { resolve = settle; }));
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading built-in instructions");
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(screen.queryByRole("region", { name: "AIQSA default instructions preview" })).toBeNull();
    expect(preview.mock.calls[0][1]?.aborted).toBe(true);
    await act(async () => resolve({ ...platformPreview, visibleAnswerContract: "late" }));
    expect(screen.queryByText("late")).toBeNull();
  });

  it("retries preview failure and returns to the list without changing presets", async () => {
    await manage();
    preview.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("built-in instructions are unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(platformPreview.visibleAnswerContract);
    expect(preview).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(screen.getByRole("button", { name: "View" })).toHaveFocus();
    expect(screen.queryByRole("region", { name: "AIQSA default instructions preview" })).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
