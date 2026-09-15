import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InstructionsSettingsPanel } from "./InstructionsSettingsPanel";
import { InstructionPresetApiError, requestInstructionPreset, requestInstructionPresets } from "./instructionPresetsApi";

vi.mock("./instructionPresetsApi", async importOriginal => ({ ...await importOriginal<typeof import("./instructionPresetsApi")>(),
  requestInstructionPreset: vi.fn(), requestInstructionPresets: vi.fn() }));
const request = vi.mocked(requestInstructionPresets), detail = vi.mocked(requestInstructionPreset);
const preset = { id: "preset", name: "Work", revision: 1, updatedAt: "2026-09-15T10:00:00.000Z", systemInstructions: "Saved instructions", responseReminder: "Answer in Spanish" };
const state = { activePresetId: "preset", selectionVersion: 1, presets: [{ id: preset.id, name: preset.name, revision: 1, updatedAt: preset.updatedAt, firstLine: preset.systemInstructions }] };
async function manage() {
  render(<InstructionsSettingsPanel />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Active instructions" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Manage presets…" }));
}
beforeEach(() => { request.mockReset().mockResolvedValue(state); detail.mockReset().mockResolvedValue(preset); });
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
});
