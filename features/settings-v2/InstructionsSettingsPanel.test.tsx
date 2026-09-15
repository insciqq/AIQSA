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
