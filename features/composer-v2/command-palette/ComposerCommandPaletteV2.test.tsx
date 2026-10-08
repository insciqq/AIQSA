import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatHeaderGalleryAssistants } from "@/app/ui-v2-fixture/_fixtures/ChatHeaderV2Gallery";
import { composerGalleryAssistant, composerGalleryConfig } from "@/app/ui-v2-fixture/_fixtures/ComposerV2Gallery";
import type { AssistantSummary } from "@/lib/contracts/assistants";
import { explicitKnowledgeSelection } from "@/lib/contracts/knowledge";
import { ComposerV2 } from "../ComposerV2";
import type { ComposerPaletteEntry } from "./paletteModel";

type ComposerProps = Parameters<typeof ComposerV2>[0];

const SKILLS = [
  { description: "Condense the sources into a short brief", id: "summarize", name: "Summarize sources" },
  { description: "Decisions and owners", id: "weekly", name: "Weekly summary" },
  { description: "Check the summary claims", id: "fact", name: "Fact check" }
];

const [baseAssistant] = chatHeaderGalleryAssistants as [AssistantSummary];
function assistantSummary(id: string, name: string, overrides: Partial<AssistantSummary> = {}): AssistantSummary {
  return { ...baseAssistant, archived: false, availability: { ok: true }, id, name, owned: true, ...overrides };
}

type HarnessProps = Partial<ComposerProps> & Readonly<{
  initialDraft?: string;
  initialPins?: readonly string[];
  onPin?(id: string): void;
  onSkillSearch?(query: string): void;
}>;

/** The shell's part: a controlled draft and the Skill library's pins. */
function Harness({ initialDraft = "", initialPins = [], onPin, onSkillSearch, ...overrides }: HarnessProps) {
  const [draft, setDraft] = useState(initialDraft);
  const [pins, setPins] = useState<readonly string[]>(initialPins);
  return (
    <ComposerV2
      config={composerGalleryConfig}
      draft={draft}
      onDraftChange={setDraft}
      onOpenSkillLibrary={vi.fn()}
      onSelectKnowledgeSelection={vi.fn()}
      onSelectMcp={vi.fn()}
      onSelectModel={vi.fn()}
      onSelectSearchOptionIds={vi.fn()}
      onSend={vi.fn()}
      onUploadFiles={vi.fn()}
      paletteSkills={{
        items: SKILLS,
        pin: (id) => {
          onPin?.(id);
          setPins((current) => [...current, id]);
        },
        ...(onSkillSearch ? { search: onSkillSearch } : {}),
        state: "ready"
      }}
      selectedModelId="gpt-5.2"
      selectedProvider="openai-work"
      selectedSkillIds={pins}
      {...overrides}
    />
  );
}

function field() {
  return screen.getByLabelText("Message", { selector: "textarea" }) as HTMLTextAreaElement;
}

/** Types like a user: each value is the field's whole text after a keystroke. */
function type(...values: string[]) {
  for (const value of values) fireEvent.change(field(), { target: { value } });
}

function list() {
  return screen.getByRole("listbox", { name: "Commands" });
}

function activeOption() {
  const id = field().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
}

function option(name: string | RegExp) {
  return within(list()).getByRole("option", { name });
}

function key(name: string, init: Partial<KeyboardEventInit> = {}) {
  fireEvent.keyDown(field(), { key: name, ...init });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("composer / palette trigger and close", () => {
  it("opens from a slash in an empty draft as a combobox whose focus stays in the field", () => {
    render(<Harness />);
    field().focus();
    type("/");
    expect(field()).toHaveAttribute("role", "combobox");
    expect(field()).toHaveAttribute("aria-expanded", "true");
    expect(field()).toHaveAttribute("aria-controls", list().id);
    expect(document.activeElement).toBe(field());
    expect(within(list()).getAllByRole("group").map((group) => group.getAttribute("aria-labelledby"))
      .map((id) => document.getElementById(id!)?.textContent)).toEqual(["Skills", "Actions", "Models"]);
  });

  it("never opens for a slash inside text, a pasted command or a draft that only becomes a slash", () => {
    render(<Harness initialDraft="Hello" />);
    type("Hello /");
    expect(screen.queryByRole("listbox")).toBeNull();
    type("", "/sum");
    expect(screen.queryByRole("listbox")).toBeNull();
    type("/ ", "/");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field()).not.toHaveAttribute("role");
  });

  it("Escape keeps the typed text and does not reopen while typing on", () => {
    render(<Harness />);
    type("/", "/sum");
    key("Escape");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field()).toHaveValue("/sum");
    type("/summary");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes when a space follows the slash, when the slash is deleted, and on a new line", () => {
    render(<Harness />);
    type("/", "/ ");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field()).toHaveValue("/ ");
    type("", "/");
    expect(list()).toBeInTheDocument();
    type("");
    expect(screen.queryByRole("listbox")).toBeNull();
    type("/", "/sum\n");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("does not open while a response runs, during an inline edit or before the catalog loads", () => {
    const view = render(<Harness activeRun runId="run-1" onFollowup={vi.fn()} />);
    type("/");
    expect(screen.queryByRole("listbox")).toBeNull();
    view.unmount();
    const edit = render(<Harness disabledReason="Finish or cancel the inline edit first." />);
    expect(field()).toBeDisabled();
    type("/");
    expect(screen.queryByRole("listbox")).toBeNull();
    edit.unmount();
    render(<Harness config={null} />);
    type("/");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes when a run starts or the chat changes under it", () => {
    const view = render(<Harness sessionKey="chat-a" />);
    type("/");
    expect(list()).toBeInTheDocument();
    view.rerender(<Harness sessionKey="chat-b" />);
    expect(screen.queryByRole("listbox")).toBeNull();
    type("", "/");
    expect(list()).toBeInTheDocument();
    view.rerender(<Harness sessionKey="chat-b" activeRun />);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes when the field loses focus and on an outside press, not on a press in the field", () => {
    render(<><button type="button">Elsewhere</button><Harness /></>);
    field().focus();
    type("/");
    fireEvent.pointerDown(field());
    expect(list()).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    type("", "/");
    fireEvent.blur(field());
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("composer / palette filtering and keyboard", () => {
  it("filters Skills by name then description and pins the best match with Enter", () => {
    const onPin = vi.fn(), onSend = vi.fn();
    render(<Harness onPin={onPin} onSend={onSend} />);
    type("/", "/s", "/sum");
    const skills = within(list()).getAllByRole("option").filter((element) => element.textContent?.includes("Always use"));
    expect(skills.map((element) => element.querySelector(".v2-composer-palette-label")?.textContent))
      .toEqual(["Summarize sources", "Weekly summary", "Fact check"]);
    expect(activeOption()).toHaveTextContent("Summarize sources");
    expect(activeOption()).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Change Skills mode" })).toHaveAccessibleDescription("Skills: Auto");
    key("Enter");
    expect(onPin).toHaveBeenCalledWith("summarize");
    expect(onSend).not.toHaveBeenCalled();
    expect(field()).toHaveValue("");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Change Skills mode" }))
      .toHaveAccessibleDescription("Skills: Auto · 1 pinned (always loaded)");
  });

  it("moves with arrows, Home and End over runnable entries only, wraps, and runs with Tab", () => {
    const onPin = vi.fn();
    render(<Harness initialPins={["weekly"]} onPin={onPin} />);
    type("/", "/sum");
    expect(option(/Weekly summary/u)).toHaveAttribute("aria-disabled", "true");
    expect(activeOption()).toHaveTextContent("Summarize sources");
    key("ArrowDown");
    expect(activeOption()).toHaveTextContent("Fact check");
    key("ArrowDown");
    expect(activeOption()).toHaveTextContent("Summarize sources");
    key("ArrowUp");
    expect(activeOption()).toHaveTextContent("Fact check");
    key("Home");
    expect(activeOption()).toHaveTextContent("Summarize sources");
    key("End");
    const last = activeOption();
    expect(last).not.toHaveTextContent("Summarize sources");
    key("Home");
    key("ArrowDown");
    key("Tab");
    expect(onPin).toHaveBeenCalledWith("fact");
    expect(field()).toHaveValue("");
  });

  it("restarts at the best match when the filter changes and keeps Shift+arrow for text selection", () => {
    render(<Harness />);
    type("/");
    key("ArrowDown");
    const second = activeOption();
    type("/f");
    expect(activeOption()).toHaveTextContent("Fact check");
    expect(activeOption()).not.toBe(second);
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown", shiftKey: true });
    field().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("says No matches and lets Enter close the palette without sending", () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    type("/", "/zzzz");
    expect(screen.getByRole("status")).toHaveTextContent("No matches");
    expect(field()).not.toHaveAttribute("aria-activedescendant");
    key("Enter");
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field()).toHaveValue("/zzzz");
  });

  it("runs a row on click or tap without taking focus from the field, and hover moves the highlight", () => {
    const onPin = vi.fn();
    render(<Harness onPin={onPin} />);
    field().focus();
    type("/", "/fact");
    const row = option(/Fact check/u);
    expect(fireEvent.mouseDown(row)).toBe(false);
    fireEvent.mouseMove(option(/Fact check/u));
    expect(activeOption()).toHaveTextContent("Fact check");
    fireEvent.click(row);
    expect(onPin).toHaveBeenCalledWith("fact");
    expect(document.activeElement).toBe(field());
  });

  it("asks the Skill library for matching Skills after a typing pause", () => {
    vi.useFakeTimers();
    const onSkillSearch = vi.fn();
    render(<Harness onSkillSearch={onSkillSearch} />);
    type("/");
    act(() => { vi.advanceTimersByTime(250); });
    expect(onSkillSearch).toHaveBeenLastCalledWith("");
    type("/m", "/me", "/meet");
    act(() => { vi.advanceTimersByTime(100); });
    expect(onSkillSearch).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(150); });
    expect(onSkillSearch).toHaveBeenLastCalledWith("meet");
    expect(onSkillSearch).toHaveBeenCalledTimes(2);
  });

  it("says when the Skills are still loading or could not be loaded", () => {
    const view = render(<Harness paletteSkills={{ items: [], pin: vi.fn(), state: "loading" }} />);
    type("/");
    expect(screen.getByText("Loading Skills…")).toHaveAttribute("role", "status");
    view.rerender(<Harness paletteSkills={{ items: [], pin: vi.fn(), state: "error" }} />);
    expect(screen.getByText("Skills could not be loaded.")).toBeInTheDocument();
  });
});

describe("composer / palette entries mirror existing actions", () => {
  it("shows a pinned Skill and an Assistant's Skill as in force, and the pin limit as a reason", () => {
    const view = render(<Harness initialPins={["weekly"]} assistant={{
      current: composerGalleryAssistant({}), resetRow: vi.fn()
    }} paletteSkills={{ items: [...SKILLS, { description: "", id: "skill-citations", name: "Policy citations" }], pin: vi.fn(), state: "ready" }} />);
    type("/");
    expect(option(/Weekly summary/u)).toHaveTextContent("Pinned · Always use");
    expect(option(/Weekly summary/u).querySelector(".v2-composer-palette-check")).not.toBeNull();
    expect(option(/Policy citations/u)).toHaveTextContent("Always used by Research editor");
    expect(option(/Policy citations/u)).toHaveAttribute("aria-disabled", "true");
    view.unmount();
    const pins = Array.from({ length: 32 }, (_, index) => `pin-${index}`);
    render(<Harness initialPins={pins} />);
    type("/", "/fact");
    expect(option(/Fact check/u)).toHaveTextContent("Up to 32 Skills can be pinned. Remove one before pinning this Skill.");
    expect(option(/Fact check/u)).toHaveAttribute("aria-disabled", "true");
    expect(option(/Fact check/u)).toHaveAttribute("data-disabled");
  });

  it("opens the Knowledge, MCP and Search layers as their chips do", () => {
    render(<Harness selectedSearchOptionIds={["web-primary"]} />);
    type("/", "/choose know");
    key("Enter");
    expect(screen.getByRole("menu", { name: "Knowledge" })).toBeInTheDocument();
    expect(field()).toHaveValue("");
    fireEvent.keyDown(screen.getByRole("menu", { name: "Knowledge" }), { key: "Escape" });
    type("/", "/mcp");
    key("Enter");
    expect(screen.getByRole("menu", { name: "MCP tools" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu", { name: "MCP tools" }), { key: "Escape" });
    type("/", "/web search");
    key("Enter");
    expect(screen.getByRole("dialog", { name: "Web search" })).toBeInTheDocument();
  });

  it("selects a Knowledge base by name like its layer row, with the layer's limits", () => {
    const onSelectKnowledgeSelection = vi.fn();
    render(<Harness onSelectKnowledgeSelection={onSelectKnowledgeSelection} />);
    type("/");
    expect(within(list()).queryByRole("option", { name: /Product research/u })).toBeNull();
    type("/prod");
    expect(option(/Product research/u)).toHaveTextContent("Knowledge base · 27 documents");
    key("Enter");
    expect(onSelectKnowledgeSelection).toHaveBeenCalledWith(expect.objectContaining({ baseIds: ["kb-product"], mode: "explicit" }));
    type("/", "/архив");
    expect(option(/Архив проекта/u)).toHaveAttribute("aria-disabled", "true");
  });

  it("turns web search off, Workspace and Agent on or off, with the chips' reasons", () => {
    const onSelectSearchOptionIds = vi.fn(), onWorkspace = vi.fn(), onAgent = vi.fn();
    const workspace = { available: true, busy: false, enabled: true, internetEnabled: false, loading: false,
      onToggle: onWorkspace, sessionState: "ready" as const };
    const view = render(<Harness selectedSearchOptionIds={["web-primary"]} onSelectSearchOptionIds={onSelectSearchOptionIds}
      workspace={workspace} agent={{ enabled: false, onToggle: onAgent }} />);
    type("/", "/turn off web");
    key("Enter");
    expect(onSelectSearchOptionIds).toHaveBeenCalledWith([]);
    type("/", "/turn off work");
    key("Enter");
    expect(onWorkspace).toHaveBeenCalledWith(false);
    type("/", "/turn on agent");
    key("Enter");
    expect(onAgent).toHaveBeenCalledWith(true);
    // The chip's own mode notice follows (the mocked toggle leaves the mode unchanged).
    expect(screen.getByRole("status")).toHaveTextContent(/^Agent (on|off)/u);
    view.rerender(<Harness selectedKnowledgeSelection={explicitKnowledgeSelection({ baseIds: ["kb-finance"] })}
      workspace={{ ...workspace, available: false, enabled: false, unavailableReason: "installation_disabled" }}
      agent={{ enabled: false, onToggle: onAgent }} />);
    type("", "/");
    expect(option(/Turn on Agent/u)).toHaveTextContent("Turn off Knowledge to use Agent.");
    expect(option(/Turn on Workspace/u)).toHaveTextContent("Workspace is disabled by the administrator.");
    fireEvent.click(option(/Turn on Agent/u));
    expect(onAgent).toHaveBeenCalledTimes(1);
  });

  it("creates an artifact and opens the file dialog like the + menu, with its blocking reasons", () => {
    const onCreateArtifact = vi.fn();
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    const view = render(<Harness onCreateArtifact={onCreateArtifact} />);
    type("/", "/create art");
    key("Enter");
    expect(onCreateArtifact).toHaveBeenCalledOnce();
    type("/", "/attach");
    key("Enter");
    expect(click).toHaveBeenCalledOnce();
    view.rerender(<Harness onCreateArtifact={onCreateArtifact} sharedProject onUploadFiles={undefined} />);
    type("", "/");
    expect(option(/Create artifact/u)).toHaveTextContent("Not available in projects");
    expect(option(/Attach files/u)).toHaveTextContent("Unavailable");
    expect(option(/Attach files/u)).toHaveAttribute("aria-disabled", "true");
  });

  it("switches the model like the header selector, and lists a fixed model's reason", () => {
    const onSelectModel = vi.fn();
    const view = render(<Harness onSelectModel={onSelectModel} />);
    type("/", "/gem");
    key("Enter");
    expect(onSelectModel).toHaveBeenCalledWith(expect.objectContaining({ modelId: "gemini-3-pro" }));
    type("/", "/gpt");
    expect(option(/^GPT-5\.2OpenAI/u)).toHaveAttribute("data-current");
    view.rerender(<Harness onSelectModel={onSelectModel} assistant={{
      current: composerGalleryAssistant({ policies: { model: "fixed" } }), resetRow: vi.fn()
    }} />);
    type("", "/", "/gem");
    expect(option(/Gemini 3 Pro/u)).toHaveTextContent("Fixed by Research editor");
    key("Enter");
    expect(onSelectModel).toHaveBeenCalledTimes(1);
  });

  it("switches Assistants like the header picker and opens the picker", () => {
    const choose = vi.fn(), openPicker = vi.fn(), load = vi.fn();
    render(<Harness paletteAssistants={{
      choose, currentId: "current", items: [
        assistantSummary("current", "Research helper"),
        assistantSummary("other", "Release writer"),
        assistantSummary("broken", "Old helper", { availability: { ok: false, reason: "model_access" }, owned: false }),
        assistantSummary("archived", "Archived helper", { archived: true })
      ], load, openPicker, pending: false
    }} />);
    type("/");
    expect(load).toHaveBeenCalledOnce();
    expect(option(/Research helper/u)).toHaveAttribute("data-current");
    expect(option(/Old helper/u)).toHaveTextContent("Not available to you");
    expect(within(list()).queryByRole("option", { name: /Archived helper/u })).toBeNull();
    type("/release");
    key("Enter");
    expect(choose).toHaveBeenCalledWith("other");
    type("/", "/choose an");
    key("Enter");
    expect(openPicker).toHaveBeenCalledOnce();
  });

  it("lists and runs an entry another feature registers", () => {
    const run = vi.fn();
    const entry: ComposerPaletteEntry = { detail: "Ask another model to check the answer", id: "review", label: "Review answer",
      run, section: "actions" };
    const blocked: ComposerPaletteEntry = { ...entry, disabledReason: "No answer to review yet", id: "review-blocked", label: "Review again" };
    render(<Harness commandPaletteEntries={[entry, blocked]} />);
    type("/", "/review");
    expect(option(/Review again/u)).toHaveTextContent("No answer to review yet");
    key("Enter");
    expect(run).toHaveBeenCalledOnce();
    expect(field()).toHaveValue("");
  });
});
