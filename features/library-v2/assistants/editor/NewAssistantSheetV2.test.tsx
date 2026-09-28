import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AssistantNewAssistantView } from "@/components/assistants/libraryViewContracts";
import {
  ASSISTANT_MAX_STARTER_PROMPTS,
  ASSISTANT_STARTER_PROMPT_MAX_LENGTH,
  ASSISTANT_SYSTEM_PROMPT_MAX_LENGTH,
  ASSISTANT_DESCRIPTION_MAX_LENGTH,
  ASSISTANT_NAME_MAX_LENGTH
} from "@/lib/contracts/assistants";
import { ASSISTANT_TEMPLATES } from "./assistantTemplates";
import { NewAssistantSheetV2 } from "./NewAssistantSheetV2";

function view(overrides: Partial<AssistantNewAssistantView> = {}): AssistantNewAssistantView {
  return {
    onBlank: vi.fn(),
    onClose: vi.fn(),
    onFromCurrentChat: vi.fn(),
    onOpen: vi.fn(),
    onTemplate: vi.fn(),
    open: true,
    ...overrides
  };
}

describe("New assistant sheet", () => {
  it("offers Blank, the current chat and six templates, and saves nothing on Blank", () => {
    const current = view();
    render(<NewAssistantSheetV2 view={current} />);

    const sheet = screen.getByRole("dialog", { name: "New assistant" });
    expect(sheet).toHaveAccessibleDescription("Start from a template or from your current chat. Nothing is saved until you press Create.");
    expect(within(sheet).getAllByRole("radio").map((radio) => radio.closest("label")?.querySelector("span")?.textContent)).toEqual([
      "Blank", "From current chat", "Writing editor", "Code reviewer", "Research analyst", "Meeting notes", "Translator", "Support with Knowledge"
    ]);
    expect(within(sheet).getByRole("radio", { name: "Blank" })).toBeChecked();
    expect(within(sheet).getByRole("radio", { name: "Blank" })).toHaveAccessibleDescription("Only a name. Your Chat defaults fill the rest.");
    expect(sheet).toHaveTextContent("Templates are built into AIQSA. They set the name, description, instructions and starters; no models, tools or Knowledge.");
    fireEvent.click(within(sheet).getByRole("button", { name: "Continue" }));
    expect(current.onBlank).toHaveBeenCalledOnce();
    expect(current.onTemplate).not.toHaveBeenCalled();
  });

  it("prefills only identity, instructions and starters from a template", () => {
    const current = view();
    render(<NewAssistantSheetV2 view={current} />);

    fireEvent.click(screen.getByRole("radio", { name: "Code reviewer" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const [prefill, options] = vi.mocked(current.onTemplate).mock.calls[0]!;
    expect(Object.keys(prefill).sort()).toEqual(["description", "name", "starterPrompts", "systemPrompt"]);
    expect(prefill).toMatchObject({
      description: "Names the file and line, explains the failure, proposes the smallest fix.",
      name: "Code reviewer"
    });
    expect(options).toBeUndefined();
  });

  it("opens Knowledge for Support with Knowledge and carries the current chat on request", () => {
    const current = view();
    render(<NewAssistantSheetV2 view={current} />);

    fireEvent.click(screen.getByRole("radio", { name: "Support with Knowledge" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(current.onTemplate).toHaveBeenCalledWith(expect.objectContaining({ name: "Support with Knowledge" }), { expandedRow: "knowledge" });

    fireEvent.click(screen.getByRole("radio", { name: "From current chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(current.onFromCurrentChat).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(current.onClose).toHaveBeenCalledOnce();
  });

  it("renders nothing while closed", () => {
    render(<NewAssistantSheetV2 view={view({ open: false })} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("built-in templates", () => {
  it("fit the Assistant limits and use only the existing instruction variables", () => {
    expect(ASSISTANT_TEMPLATES).toHaveLength(6);
    for (const { prefill } of ASSISTANT_TEMPLATES) {
      expect(prefill.name.length).toBeLessThanOrEqual(ASSISTANT_NAME_MAX_LENGTH);
      expect(prefill.description.length).toBeLessThanOrEqual(ASSISTANT_DESCRIPTION_MAX_LENGTH);
      expect(prefill.systemPrompt.length).toBeLessThanOrEqual(ASSISTANT_SYSTEM_PROMPT_MAX_LENGTH);
      expect(prefill.starterPrompts.length).toBeGreaterThan(0);
      expect(prefill.starterPrompts.length).toBeLessThanOrEqual(ASSISTANT_MAX_STARTER_PROMPTS);
      for (const starter of prefill.starterPrompts) {
        expect(starter.trim()).toBe(starter);
        expect(starter.length).toBeLessThanOrEqual(ASSISTANT_STARTER_PROMPT_MAX_LENGTH);
      }
      for (const variable of prefill.systemPrompt.match(/\{[^{}\s]+\}/gu) ?? []) {
        expect(["{local_date}", "{local_time}"]).toContain(variable);
      }
    }
  });
});
