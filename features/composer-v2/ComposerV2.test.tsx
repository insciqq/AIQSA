import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ComposerConfig } from "@/lib/contracts/composerConfig";
import type { AssistantRowKey, AssistantRowPolicy } from "@/lib/contracts/assistants";
import {
  EMPTY_KNOWLEDGE_SELECTION,
  explicitKnowledgeSelection,
  inheritedKnowledgeSelection
} from "@/lib/contracts/knowledge";
import type { ComposerV2Assistant } from "./AssistantRowProvenanceV2";
import { ComposerV2, type ComposerV2Layer, type ComposerV2LayerController } from "./ComposerV2";
import { HeaderModelSelectorV2 } from "@/features/workspace-v2/WorkspaceHeaderV2";
import {
  composerGalleryAssistant,
  composerGalleryConfig,
  composerGalleryProjectConfig
} from "@/app/ui-v2-fixture/_fixtures/ComposerV2Gallery";

function props(overrides: Partial<Parameters<typeof ComposerV2>[0]> = {}) {
  return {
    config: composerGalleryConfig,
    draft: "Проверь источники",
    onDraftChange: vi.fn(),
    onSelectKnowledgeBaseIds: vi.fn(),
    onSelectModel: vi.fn(),
    onSelectSearchOptionIds: vi.fn(),
    onSend: vi.fn(),
    selectedKnowledgeBaseIds: ["kb-finance"],
    selectedModelId: "gpt-5.2",
    selectedProvider: "openai-work",
    selectedSearchOptionIds: ["web-primary"],
    ...overrides
  } satisfies Parameters<typeof ComposerV2>[0];
}

describe("comment-aware composer send controls", () => {
  it("allows comment-only sends and counts the entire built follow-up", () => {
    const comments = [{ id: "one", quote: "Selected fragment", text: "My comment" }];
    const onSend = vi.fn(), onFollowup = vi.fn();
    const view = render(<ComposerV2 {...props({ draft: "", comments, onSend })} />);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledOnce();
    view.rerender(<ComposerV2 {...props({ draft: "x".repeat(15990), comments, activeRun: true, runId: "run", onFollowup })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("edit or delete a comment");
    expect(screen.getByRole("button", { name: /Send follow-up/u })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    expect(onFollowup).not.toHaveBeenCalled();
  });

  it("says once when the unsent input is too large to keep after a reload and keeps it sendable", () => {
    const onSend = vi.fn();
    const view = render(<ComposerV2 {...props({ draft: "long text", onSend })} />);
    expect(screen.queryByText(/Too large to keep after a reload/u)).toBeNull();
    view.rerender(<ComposerV2 {...props({ draft: "long text", onSend, draftTooLargeToKeep: true })} />);
    const notice = screen.getByText(/Too large to keep after a reload/u);
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveTextContent("only the last version that fit would come back. Send this message, or shorten its text or comments.");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("long text");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledOnce();
  });
});

const ALL_FIXED: Record<AssistantRowKey, AssistantRowPolicy> = {
  controls: "fixed", knowledge: "fixed", model: "fixed", search: "fixed", skills: "fixed", tools: "fixed"
};

/** The chat's Assistant as the shell hands it to the composer. */
function galleryAssistant(
  input: Parameters<typeof composerGalleryAssistant>[0] = {},
  resetRow: ComposerV2Assistant["resetRow"] = vi.fn()
): ComposerV2Assistant {
  return { current: composerGalleryAssistant(input), resetRow };
}

function galleryWorkspace() {
  return {
    available: true,
    busy: false,
    enabled: true,
    internetEnabled: false,
    loading: false,
    onToggle: vi.fn(),
    sessionState: "ready" as const
  };
}

/** Search, Knowledge, MCP and Skills: the chips an Assistant row can set. */
function assistantChips() {
  return [
    screen.getByRole("button", { name: /^Choose web search/u }),
    screen.getByRole("button", { name: "Choose Knowledge" }),
    screen.getByRole("button", { name: "Change MCP mode" }),
    screen.getByRole("button", { name: "Change Skills mode" })
  ];
}

/**
 * The model picker is opened from outside the composer (the header model
 * selector in the shell): this harness stands in for that opener through the
 * layer controller and mirrors the open layer as `aria-expanded`.
 */
function ComposerWithModelOpener(overrides: Partial<Parameters<typeof ComposerV2>[0]> = {}) {
  const controller = useRef<ComposerV2LayerController | null>(null);
  const [layer, setLayer] = useState<ComposerV2Layer>(null);
  return (
    <>
      <button
        aria-expanded={layer === "model"}
        aria-haspopup="dialog"
        type="button"
        onClick={(event) => controller.current?.toggle("model", event.currentTarget)}
      >
        GPT-5.2
      </button>
      <ComposerV2 {...props(overrides)} layerController={controller} onLayerChange={setLayer} />
    </>
  );
}

/** The real header button, locked while the Assistant fixes the model. */
function ComposerWithLockedModelOpener(overrides: Partial<Parameters<typeof ComposerV2>[0]> = {}) {
  const controller = useRef<ComposerV2LayerController | null>(null);
  const [layer, setLayer] = useState<ComposerV2Layer>(null);
  return (
    <>
      <HeaderModelSelectorV2 selector={{
        expanded: layer === "model",
        family: "openai",
        fromAssistant: true,
        label: "OpenAI",
        locked: true,
        name: "GPT-5.2",
        onToggle: (anchor) => controller.current?.toggle("model", anchor),
        title: "GPT-5.2 · fixed by Research editor"
      }} />
      <ComposerV2 {...props(overrides)} layerController={controller} onLayerChange={setLayer} />
    </>
  );
}

describe("Composer v2", () => {
  it("sends text follow-ups with keyboard or button while Stop stays separate", () => {
    const onFollowup = vi.fn(), onStop = vi.fn(), onSend = vi.fn();
    const value = props({ activeRun: true, runId: "run", onFollowup, onStop, onSend, uploading: true, artifactCreate: true });
    const { rerender } = render(<ComposerV2 {...value} />);
    const textbox = screen.getByRole("textbox", { name: "Message" });
    expect(textbox).toHaveAttribute("placeholder", "Follow up…");
    expect(screen.getByRole("button", { name: "Send follow-up" })).toBeEnabled();
    fireEvent.keyDown(textbox, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(textbox, { key: "Enter", isComposing: true });
    expect(onFollowup).not.toHaveBeenCalled();
    fireEvent.keyDown(textbox, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(onFollowup).toHaveBeenNthCalledWith(1, "run");
    expect(onFollowup).toHaveBeenCalledTimes(2);
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stop answer" }));
    expect(onStop).toHaveBeenCalledWith("run");
    rerender(<ComposerV2 {...value} followupSending />);
    expect(screen.getByRole("button", { name: "Send follow-up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop answer" })).toBeEnabled();
    rerender(<ComposerV2 {...value} draft={"x".repeat(16_001)} />);
    expect(screen.getByRole("button", { name: "Send follow-up" })).toBeDisabled();
    rerender(<ComposerV2 {...value} activeRun={false} uploading={false} />);
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Stop answer" })).toBeNull();
  });

  it("keeps unsupported active modes and empty follow-ups unsendable", () => {
    const onSend = vi.fn(), onFollowup = vi.fn();
    const { rerender } = render(<ComposerV2 {...props({ activeRun: true, runId: "run", onSend })} />);
    expect(screen.queryByRole("button", { name: "Send follow-up" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    rerender(<ComposerV2 {...props({ activeRun: true, runId: "run", onFollowup, draft: "  " })} />);
    expect(screen.getByRole("button", { name: "Send follow-up" })).toBeDisabled();
  });
  it("offers keyboard Auto and Off plus Pin without removing pinned Skills", () => {
    const onSelectSkillsMode = vi.fn();
    const onOpenSkillLibrary = vi.fn();
    render(<ComposerV2 {...props({ onSelectSkillsMode, onOpenSkillLibrary, skillsMode: "auto", selectedSkillIds: ["review"] })} />);
    const opener = screen.getByRole("button", { name: "Change Skills mode" });
    expect(opener).toHaveAccessibleDescription(/Skills: Auto · 1 pinned \(always loaded\)/);
    fireEvent.click(opener);
    const off = screen.getByRole("menuitemradio", { name: /^Off/ });
    screen.getByRole("menuitemradio", { name: /^Auto/ }).focus();
    fireEvent.keyDown(screen.getByRole("menuitemradio", { name: /^Auto/ }), { key: "ArrowDown" });
    expect(off).toHaveFocus();
    fireEvent.click(off);
    expect(onSelectSkillsMode).toHaveBeenCalledWith("off");
    expect(screen.queryByRole("menu", { name: "Skills" })).toBeNull();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("menuitem", { name: /^Skills…/ }));
    expect(onOpenSkillLibrary).toHaveBeenCalledOnce();
  });

  it("disables Auto for a model without tools while pinned instructions and sending remain available", () => {
    const config = { ...composerGalleryConfig, catalog: { ...composerGalleryConfig.catalog, models: composerGalleryConfig.catalog.models.map(model => ({ ...model, capabilities: { ...model.capabilities, toolCalling: false } })) } };
    render(<ComposerV2 {...props({ config, initialLayer: "skills", onSelectSkillsMode: vi.fn(), selectedSkillIds: ["review"] })} />);
    expect(screen.getByRole("menuitemradio", { name: /^Auto/ })).toBeDisabled();
    expect(screen.getByRole("menuitemradio", { name: /^Auto/ })).toHaveTextContent("Always use instructions still apply");
    expect(screen.getByRole("menuitemradio", { name: /^Off/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });

  it("offers one-use artifact creation and preserves its draft while explaining an incompatible mode", () => {
    const onCreateArtifact = vi.fn();
    const onRemoveArtifactCreate = vi.fn();
    const onSend = vi.fn();
    const value = props({ draft: "Build a clock", onCreateArtifact, onRemoveArtifactCreate, onSend });
    const { rerender } = render(<ComposerV2 {...value} />);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Create artifact/ }));
    expect(onCreateArtifact).toHaveBeenCalledOnce();
    rerender(<ComposerV2 {...value} artifactCreate />);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute("placeholder", "Describe the page, slides, game or chart…");
    rerender(<ComposerV2 {...value} artifactCreate artifactUnavailableReason="Not available in projects" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Not available in projects");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Build a clock");
    fireEvent.click(screen.getByRole("button", { name: "Remove artifact creation" }));
    expect(onRemoveArtifactCreate).toHaveBeenCalledOnce();
  });
  it.each(["Not available in projects", "Not available in temporary chats"])("explains unavailable creation: %s", reason => {
    render(<ComposerV2 {...props({ onCreateArtifact: vi.fn(), artifactUnavailableReason: reason })} />);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("menuitem", { name: new RegExp(`Create artifact.*${reason}`) })).toBeDisabled();
  });
  it("lets Agent select artifact creation and send a create or edit intent", () => {
    const onCreateArtifact = vi.fn(), onSend = vi.fn();
    const value = props({ onCreateArtifact, onSend, selectedKnowledgeBaseIds: [], artifactUnavailableReason: undefined,
      agent: { enabled: true, onToggle: vi.fn() } });
    const { rerender } = render(<ComposerV2 {...value} />);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const create = screen.getByRole("menuitem", { name: /Create artifact/ });
    expect(create).toBeEnabled();
    fireEvent.click(create);
    expect(onCreateArtifact).toHaveBeenCalledOnce();
    rerender(<ComposerV2 {...value} artifactCreate />);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledOnce();
    rerender(<ComposerV2 {...value} artifactEdit={{ artifactId: "artifact", versionId: "version", title: "Page", versionNumber: 1 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledTimes(2);
  });
  it("shows a removable artifact edit without adding instruction text to the draft", () => {
    const onRemoveArtifactEdit = vi.fn();
    render(<ComposerV2 {...props({ draft: "Make it blue", onRemoveArtifactEdit,
      artifactEdit: { artifactId: "artifact", versionId: "version", title: "A small game", versionNumber: 3 } })} />);
    expect(screen.getByText("Editing “A small game” · v3")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Make it blue");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute("placeholder", "Describe the change…");
    fireEvent.click(screen.getByRole("button", { name: "Remove artifact edit" }));
    expect(onRemoveArtifactEdit).toHaveBeenCalledOnce();
  });

  it.each([false, true])("explains unavailable Agent without trapping an enabled selection: %s", (enabled) => {
    const onToggle = vi.fn(), onSend = vi.fn();
    const unavailableReason = "Agent is unavailable. Ask an administrator to check the Workspace runner.";
    render(<ComposerV2 {...props({ selectedKnowledgeBaseIds: [], onSend,
      agent: { enabled, onToggle, unavailableReason } })} />);
    const toggle = screen.getByRole("button", { name: "Agent" });
    expect(toggle).toHaveAttribute("aria-pressed", String(enabled));
    expect(toggle).toHaveAttribute("aria-disabled", String(!enabled));
    expect(toggle).toHaveAccessibleDescription(expect.stringContaining(unavailableReason));
    toggle.focus();
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);
    if (enabled) expect(onToggle).toHaveBeenCalledExactlyOnceWith(false);
    else {
      expect(onToggle).not.toHaveBeenCalled();
      expect(screen.getByRole("status")).toHaveTextContent(unavailableReason);
    }
    expect(screen.queryByRole("button", { name: "Agent details" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: "Agent" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Проверь источники");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    if (enabled) expect(onSend).not.toHaveBeenCalled();
    else expect(onSend).toHaveBeenCalledOnce();
  });

  it("toggles Agent directly, explains its restrictions and preserves other controls", () => {
    const onSelectMcp = vi.fn();
    function ControlledAgent() {
      const [enabled, onToggle] = useState(false);
      return <ComposerV2 {...props({ selectedKnowledgeBaseIds: [], selectedSearchOptionIds: [],
        selectedSkills: [{ id: "summary", name: "Signed summary" }], selectedSkillIds: ["summary"],
        mcpSelection: { mode: "auto" }, onSelectMcp, agent: { enabled, onToggle } })} />;
    }
    render(<ControlledAgent />);
    const toggle = screen.getByRole("button", { name: "Agent" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Memory and Knowledge are unavailable.");
    expect(toggle).toHaveAccessibleDescription(expect.stringContaining("selected model, Skills, MCP mode"));
    expect(screen.getByRole("button", { name: "Change Skills mode" })).toHaveAccessibleDescription(/1 pinned/);
    expect(onSelectMcp).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Проверь источники");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("status")).toHaveTextContent("Agent off.");
  });

  it("explains incompatible Agent controls and permits turning Agent off", () => {
    const onToggle = vi.fn(), onSend = vi.fn();
    render(<ComposerV2 {...props({ onSend, agent: { enabled: true, onToggle } })} />);
    const toggle = screen.getByRole("button", { name: "Agent" });
    expect(toggle).toHaveAccessibleDescription(expect.stringContaining("Turn off Knowledge"));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("keeps blocked Agent focusable and prevents changes during an active run", () => {
    const onToggle = vi.fn();
    render(<ComposerV2 {...props({ activeRun: true, selectedKnowledgeBaseIds: [],
      agent: { enabled: true, onToggle } })} />);
    const toggle = screen.getByRole("button", { name: "Agent" });
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    toggle.focus();
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("A response is running.");
  });

  it("distinguishes disabled automatic Skills from still-active pinned instructions", () => {
    const { rerender } = render(<ComposerV2 {...props({ skillsMode: "off", selectedSkillIds: ["pinned"] })} />);
    const chip = screen.getByRole("button", { name: "Change Skills mode" });
    expect(chip).toHaveAccessibleDescription("Skills: Auto off · 1 pinned (always loaded)");
    expect(chip.querySelector(".v2-composer-indicator-count")).toHaveTextContent("1");
    // Pinned Skills still apply, so the chip is not struck through as off.
    expect(chip).not.toHaveAttribute("data-off");
    fireEvent.click(chip);
    expect(screen.getByRole("menuitemradio", { name: /^Off/ })).toHaveAttribute("aria-checked", "true");

    rerender(<ComposerV2 {...props({ skillsMode: "off", selectedSkillIds: [] })} />);
    expect(screen.getByRole("button", { name: "Change Skills mode" })).toHaveAttribute("data-off");
  });

  it("does not carry an Agent notice into another chat or retain a resolved restriction", () => {
    const agent = { enabled: false, onToggle: vi.fn() };
    const { rerender } = render(<ComposerV2 {...props({ sessionKey: "chat-a", agent })} />);
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(screen.getByRole("status")).toHaveTextContent("Turn off Knowledge");
    rerender(<ComposerV2 {...props({ sessionKey: "chat-b", agent })} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    rerender(<ComposerV2 {...props({ sessionKey: "chat-a", agent, selectedKnowledgeBaseIds: [] })} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("sends with Agent and Search enabled when Knowledge is off", () => {
    const onSend = vi.fn();
    render(<ComposerV2 {...props({ selectedKnowledgeBaseIds: [], onSend,
      agent: { enabled: true, onToggle: vi.fn() } })} />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("warns about pending MCP setup on the chip and offers a touch-accessible settings action", async () => {
    const onOpenMcpSettings = vi.fn();
    const config: ComposerConfig = {
      ...composerGalleryConfig,
      mcpServers: [
        { id: "tracker", name: "Tracker", description: "", enabled: false, knownToolCount: 0, readiness: "disabled", attention: "needs_authorization" },
        { id: "files", name: "Files", description: "", enabled: true, knownToolCount: 1, readiness: "reauthorization_required" },
        { id: "idle", name: "Idle", description: "", enabled: true, knownToolCount: 1, readiness: "idle" }
      ]
    };
    const { rerender } = render(<ComposerV2 {...props({ config, onOpenMcpSettings })} />);
    const chip = screen.getByRole("button", { name: "Change MCP mode" });
    expect(chip.querySelector('[data-signal="attention"]')).not.toBeNull();
    expect(chip).toHaveAttribute("data-tooltip", "MCP: Auto. 2 MCP servers need attention. Open MCP settings.");
    expect(chip).toHaveAccessibleDescription("MCP: Auto. 2 MCP servers need attention. Open MCP settings.");
    fireEvent.click(chip);
    expect(screen.getByRole("status")).toHaveTextContent("Tracker · Needs authorization");
    expect(screen.getByRole("status")).toHaveTextContent("Files · Reconnect required");
    fireEvent.click(screen.getByRole("menuitem", { name: "Manage enabled MCP servers" }));
    expect(onOpenMcpSettings).toHaveBeenCalledOnce();
    rerender(<ComposerV2 {...props({ config: { ...config, mcpServers: [config.mcpServers[2]] }, onOpenMcpSettings })} />);
    expect(chip.querySelector('[data-signal="attention"]')).toBeNull();
    expect(chip).toHaveAccessibleDescription("MCP: Auto");
  });
  it("keeps context controls in the header, outside the composer", () => {
    const { container } = render(<ComposerV2 {...props()} />);
    expect(screen.queryByTestId("composer-memory-mode")).toBeNull();
    expect(screen.queryByTestId("header-context-indicator")).toBeNull();
    expect(container.textContent).not.toContain("Temporary chat");
  });

  it("sends on Enter, preserves Shift+Enter, and ignores every IME fallback", () => {
    const onSend = vi.fn();
    render(<ComposerV2 {...props({ onSend })} />);
    const input = screen.getByRole("textbox", { name: "Message" });

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { isComposing: true, key: "Enter" });
    fireEvent.keyDown(input, { key: "Process" });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("with Send with Enter off, Enter inserts a newline and Ctrl/⌘+Enter sends", () => {
    const onSend = vi.fn();
    render(<ComposerV2 {...props({ onSend })} sendWithEnter={false} />);
    const input = screen.getByRole("textbox", { name: "Message" });

    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { ctrlKey: true, isComposing: true, key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { ctrlKey: true, key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it("searches grouped models, wraps keyboard navigation, and restores trigger focus", async () => {
    const onSelectModel = vi.fn();
    render(<ComposerWithModelOpener onSelectModel={onSelectModel} />);
    const trigger = screen.getByRole("button", { name: "GPT-5.2" });
    expect(screen.getByTestId("composer-v2").querySelector("[aria-controls$='-model']")).toBeNull();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    // The picker is portalled beside the external opener, not inside the composer.
    const layer = screen.getByRole("dialog", { name: "Choose model" });
    expect(layer).toHaveAttribute("data-anchor", "external");
    expect(screen.getByTestId("composer-v2").contains(layer)).toBe(false);
    const search = screen.getByRole("searchbox", { name: "Search models" });
    await waitFor(() => expect(search).toHaveFocus());

    fireEvent.change(search, { target: { value: "Gemini" } });
    expect(screen.getByRole("option", { name: /Gemini 3 Pro/ })).toBeVisible();
    expect(screen.queryByRole("option", { name: /GPT-5.2 mini/ })).toBeNull();

    fireEvent.change(search, { target: { value: "" } });
    fireEvent.keyDown(search, { key: "ArrowUp" });
    expect(screen.getByRole("option", { name: /Gemini 3 Pro/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /^GPT-5\.2Reasoning/ })).toHaveFocus();
    fireEvent.click(screen.getByRole("option", { name: /GPT-5.2 mini/ }));
    expect(onSelectModel).toHaveBeenCalledWith(expect.objectContaining({
      displayName: "GPT-5.2 mini",
      provider: "openai-work"
    }));
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search models" })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Search models" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Choose model" })).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("closes each layer from the sheet scrim, the sticky close control, and Escape", async () => {
    render(<ComposerWithModelOpener />);
    const plus = screen.getByRole("button", { name: "Add" });

    // Scrim tap: the backdrop button is the touch exit of the bottom sheet.
    fireEvent.click(plus);
    expect(screen.getByRole("menu", { name: "Add" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(screen.queryByRole("menu", { name: "Add" })).toBeNull();
    await waitFor(() => expect(plus).toHaveFocus());

    // The sheet header's close control (hidden on the desktop popover).
    fireEvent.click(plus);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("menu", { name: "Add" })).toBeNull();
    await waitFor(() => expect(plus).toHaveFocus());

    // Escape keeps closing the model sheet and restores its trigger.
    const modelTrigger = screen.getByRole("button", { name: "GPT-5.2" });
    fireEvent.click(modelTrigger);
    const modelLayer = screen.getByRole("dialog", { name: "Choose model" });
    fireEvent.keyDown(modelLayer, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Choose model" })).toBeNull();
    await waitFor(() => expect(modelTrigger).toHaveFocus());
  });

  it("routes Search, Knowledge, Skills, and MCP through their own chip menus", () => {
    const onKnowledge = vi.fn();
    const onSearch = vi.fn();
    const onSelectMcp = vi.fn();
    const config: ComposerConfig = {
      ...composerGalleryConfig,
      mcpServers: [
        ...composerGalleryConfig.mcpServers,
        {
          description: "Issue tracking",
          enabled: true,
          id: "mcp-jira-enabled",
          knownToolCount: 4,
          name: "jira",
          readiness: "idle"
        }
      ],
      skills: [{
        archived: false,
        description: "Checks claims",
        id: "skill-editor",
        instructionCharacterCount: "Verify every factual claim.".length,
        name: "Careful editor",
        owned: true,
        ownerDisplayName: "Viewer",
        scope: { kind: "owner" },
        updatedAt: "2026-08-16T00:00:00.000Z",
        version: 1
      }]
    };
    const onOpenSkillLibrary = vi.fn();
    render(<ComposerV2 {...props({
      config,
      initialLayer: "add",
      onOpenSkillLibrary,
      onSelectKnowledgeBaseIds: onKnowledge,
      onSelectSearchOptionIds: onSearch,
      onSelectMcp,
      selectedKnowledgeBaseIds: ["kb-finance", "missing-base"]
    })} />);
    const menuOpen = (name: string) =>
      expect(screen.getByRole("menu", { name })).toBeVisible();
    const menuClosed = (name: string) =>
      expect(screen.queryByRole("menu", { name })).toBeNull();

    // "+" is Add only: files, Knowledge, an Assistant, Skills — no Search,
    // MCP, or Skills lists.
    menuOpen("Add");
    expect(screen.queryByRole("menuitemcheckbox", { name: /Research Search/ })).toBeNull();
    expect(screen.queryByRole("menuitemcheckbox", { name: /Careful editor/ })).toBeNull();
    expect(screen.queryByRole("menuitemradio", { name: /^Load all/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /Attach files/ })).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Skills…/ }));
    expect(onOpenSkillLibrary).toHaveBeenCalledOnce();
    menuClosed("Add");

    // Search: sources can be combined without closing the menu.
    fireEvent.click(screen.getByRole("button", { name: /^Choose web search/u }));
    expect(screen.getByRole("dialog", { name: "Web search" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Turn off search" })).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Research Search/ }));
    expect(onSearch).toHaveBeenCalledWith(["web-primary", "research-search"]);
    expect(screen.getByRole("dialog", { name: "Web search" })).toBeVisible();
    fireEvent.keyDown(screen.getByRole("checkbox", { name: /Research Search/ }), { key: "Escape" });

    // Knowledge: Off / All my Knowledge close; Base and document toggles keep
    // the picker open so several can be combined in one visit.
    fireEvent.click(screen.getByRole("button", { name: "Choose Knowledge" }));
    menuOpen("Knowledge");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Финансы 2026/ }));
    expect(onKnowledge).toHaveBeenCalledWith(["missing-base"]);
    menuOpen("Knowledge");

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Unavailable knowledge base/ }));
    expect(onKnowledge).toHaveBeenCalledWith(["kb-finance"]);
    menuOpen("Knowledge");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Off/ }));
    expect(onKnowledge).toHaveBeenLastCalledWith([]);
    menuClosed("Knowledge");

    fireEvent.click(screen.getByRole("button", { name: "Change MCP mode" }));
    menuOpen("MCP tools");
    // Disclosure of what the modes act on; enabling stays in Settings.
    expect(screen.getByTestId("composer-v2-mcp-enabled")).toHaveTextContent("Enabled servers · 2");
    expect(screen.getByTestId("composer-v2-mcp-servers")).toHaveTextContent("office-compute");
    expect(screen.getByTestId("composer-v2-mcp-servers")).toHaveTextContent("jira");
    expect(screen.queryByRole("menuitemcheckbox", { name: /office-compute/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Load all/ }));
    expect(onSelectMcp).toHaveBeenCalledWith({ mode: "load_all" });
    menuClosed("MCP tools");
  });

  it("opens the Knowledge menu from the Add menu and returns focus to the chip", async () => {
    render(<ComposerV2 {...props({ initialLayer: "add" })} />);
    fireEvent.click(screen.getByRole("menuitem", { name: /Add Knowledge/ }));
    expect(screen.getByRole("menu", { name: "Knowledge" })).toBeVisible();
    expect(screen.queryByRole("menu", { name: "Add" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu", { name: "Knowledge" }), { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Choose Knowledge" })).toHaveFocus());
  });

  it("keeps blank-chat actions in the single composer capability rail", () => {
    const initial = props({ draft: "", onUploadFiles: vi.fn() });
    const { rerender } = render(<ComposerV2 {...initial} />);

    expect(screen.queryByRole("group", { name: "Ways to start" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Choose web search: OpenAI" }))
      .toHaveAccessibleDescription("Search: OpenAI");
    expect(screen.queryByRole("button", { name: "Turn off Search" })).toBeNull();
    expect(screen.getByRole("button", { name: "Choose Knowledge" })).toBeVisible();

    rerender(<ComposerV2 {...initial} selectedSearchOptionIds={[]} />);
    expect(screen.getByRole("button", { name: "Choose web search" }))
      .toHaveAccessibleDescription("Search: Off");
    expect(screen.queryByRole("button", { name: "Turn off Search" })).toBeNull();
  });

  it("keeps an unavailable saved Search source visible and removable", () => {
    const onSearch = vi.fn();
    render(<ComposerV2 {...props({ selectedSearchOptionIds: ["retired-source"], onSelectSearchOptionIds: onSearch })} />);
    const trigger = screen.getByRole("button", { name: "Choose web search" });
    expect(trigger).toHaveAccessibleDescription("Search: Unavailable source");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("checkbox", { name: /Unavailable source/ }));
    expect(onSearch).toHaveBeenCalledWith([]);
  });

  it("closes Search with Escape after clearing disables the focused control", async () => {
    const { rerender } = render(<ComposerV2 {...props()} />);
    const trigger = screen.getByRole("button", { name: /^Choose web search/u });
    fireEvent.click(trigger);
    screen.getByRole("button", { name: "Turn off search" }).focus();
    rerender(<ComposerV2 {...props({ selectedSearchOptionIds: [] })} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Web search" })).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps every MCP mode visible, including Off with no enabled servers", () => {
    const onSelectMcp = vi.fn();
    const { rerender } = render(<ComposerV2 {...props({
      config: { ...composerGalleryConfig, mcpServers: [] },
      initialLayer: "tools",
      mcpSelection: { mode: "off" },
      onSelectMcp
    })} />);

    expect(screen.getByRole("button", { name: "Change MCP mode" }))
      .toHaveTextContent("MCP: Off");
    expect(screen.getByTestId("composer-v2-mcp-enabled")).toHaveTextContent("No servers enabled.");
    // Enabled servers are disclosed by name; only attention/failed states are counted.
    rerender(<ComposerV2 {...props({
      config: {
        ...composerGalleryConfig,
        mcpServers: [
          { ...composerGalleryConfig.mcpServers[0], readiness: "idle" },
          { ...composerGalleryConfig.mcpServers[1], enabled: true, readiness: "needs_authorization" }
        ]
      },
      initialLayer: "tools",
      mcpSelection: { mode: "off" },
      onSelectMcp
    })} />);
    expect(screen.getByTestId("composer-v2-mcp-enabled"))
      .toHaveTextContent("Enabled servers · 2 · 1 needs attention");
    expect(screen.getByTestId("composer-v2-mcp-servers")).toHaveTextContent("office-compute");
    expect(screen.getByTestId("composer-v2-mcp-servers")).toHaveTextContent("jira");
    expect(screen.getByRole("menuitemradio", { name: /^Auto/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitemradio", { name: /^Load all/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitemradio", { name: /^Off/ })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Auto/ }));
    expect(onSelectMcp).toHaveBeenCalledWith({ mode: "auto" });
  });

  it("keeps Assistants out of the Add menu and above the input", () => {
    render(<ComposerV2 {...props({ assistant: galleryAssistant(), initialLayer: "add" })} />);

    expect(screen.queryByRole("menuitem", { name: /Use an Assistant/ })).toBeNull();
    expect(screen.queryByTestId("composer-v2-assistant-lock")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove assistant" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /Add Knowledge/ })).toBeEnabled();
  });

  it("marks every control the Assistant sets with one dot and keeps every control visible", () => {
    const { rerender } = render(<ComposerV2 {...props({
      agent: { enabled: false, onToggle: vi.fn() },
      assistant: galleryAssistant(),
      onOpenSkillLibrary: vi.fn(),
      onSelectMcp: vi.fn(),
      workspace: galleryWorkspace()
    })} />);

    for (const chip of assistantChips()) {
      expect(chip).toBeEnabled();
      expect(chip).toHaveAttribute("data-provenance", "assistant");
    }
    expect(screen.getByRole("button", { name: "Change MCP mode" }))
      .toHaveAccessibleDescription("MCP: 1 server · From Research editor");
    expect(screen.getByRole("button", { name: "Agent" })).not.toHaveAttribute("data-provenance");
    expect(screen.getByRole("button", { name: /^Workspace details/ })).not.toHaveAttribute("data-provenance");

    // A row changed for this chat, a fallback and an inherit row carry no dot.
    rerender(<ComposerV2 {...props({
      assistant: galleryAssistant({
        assistantValues: { search: { mode: "inherit" } },
        deviations: { knowledge: { reason: "knowledge_access" } },
        origins: { knowledge: "fallback", search: "default", skills: "chat", tools: "chat" },
        values: { tools: { mode: "auto" } }
      }),
      onSelectMcp: vi.fn()
    })} />);
    for (const chip of assistantChips()) expect(chip).not.toHaveAttribute("data-provenance");
    expect(screen.getByRole("button", { name: "Change MCP mode" }))
      .toHaveAccessibleDescription("MCP: Auto · Changed for this chat");
    expect(screen.getByRole("button", { name: "Choose Knowledge" }))
      .toHaveAccessibleDescription(/ · Research editor's Knowledge isn't available to you; using your default$/u);

    // Without an Assistant nothing is marked and no menu explains provenance.
    rerender(<ComposerV2 {...props({ onSelectMcp: vi.fn() })} />);
    for (const chip of assistantChips()) expect(chip).not.toHaveAttribute("data-provenance");
    fireEvent.click(screen.getByRole("button", { name: "Change MCP mode" }));
    expect(screen.queryByTestId("assistant-row-provenance")).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Reset to Assistant/ })).toBeNull();
  });

  it("opens fixed rows with their options disabled and Fixed by the Assistant", () => {
    const onSelectMcp = vi.fn();
    const onSelectSkillsMode = vi.fn();
    const onKnowledge = vi.fn();
    const onSearch = vi.fn();
    const assistant = galleryAssistant({ policies: ALL_FIXED });
    render(<ComposerV2 {...props({
      assistant,
      onOpenSkillLibrary: vi.fn(),
      onSelectKnowledgeBaseIds: undefined,
      onSelectKnowledgeSelection: onKnowledge,
      onSelectMcp,
      onSelectSearchOptionIds: onSearch,
      onSelectSkillsMode,
      selectedKnowledgeSelection: explicitKnowledgeSelection({ baseIds: ["kb-finance"] }),
      selectedSearchOptionIds: []
    })} />);

    // A-13: MCP stays visible with the dot; its menu says why nothing is selectable.
    const mcp = screen.getByRole("button", { name: "Change MCP mode" });
    expect(mcp).toHaveAttribute("data-provenance", "assistant");
    expect(mcp).toHaveAccessibleDescription("MCP: 1 server · Fixed by Research editor");
    fireEvent.click(mcp);
    const tools = screen.getByRole("menu", { name: "MCP tools" });
    expect(within(tools).getByTestId("assistant-row-provenance")).toHaveTextContent("Fixed by Research editor");
    // The Assistant's list is the chosen option, in force and unchangeable;
    // the user's own modes and servers do not apply to this chat.
    const servers = within(tools).getByRole("menuitemradio", { name: /^Research editor's servers/ });
    expect(servers).toHaveTextContent("All tools of: office-compute");
    expect(servers).toHaveAttribute("aria-checked", "true");
    expect(servers).toHaveAttribute("aria-disabled", "true");
    for (const mode of [/^Auto/, /^Load all/, /^Off/]) {
      const row = within(tools).getByRole("menuitemradio", { name: mode });
      expect(row).toBeDisabled();
      expect(row).toHaveAttribute("aria-checked", "false");
    }
    expect(within(tools).queryByRole("group", { name: "Included by the Assistant" })).toBeNull();
    expect(within(tools).queryByTestId("composer-v2-mcp-enabled")).toBeNull();
    expect(within(tools).queryByTestId("composer-v2-mcp-servers")).toBeNull();
    fireEvent.click(servers);
    expect(onSelectMcp).not.toHaveBeenCalled();
    expect(within(tools).queryByRole("menuitem", { name: /Reset to Assistant/ })).toBeNull();
    fireEvent.keyDown(tools, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: /^Choose web search/u }));
    const search = screen.getByRole("dialog", { name: "Web search" });
    expect(within(search).getByTestId("assistant-row-provenance")).toHaveTextContent("Fixed by Research editor");
    for (const source of within(search).getAllByRole("checkbox")) expect(source).toBeDisabled();
    fireEvent.keyDown(search, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Choose Knowledge" }));
    const knowledge = screen.getByRole("menu", { name: "Knowledge" });
    expect(within(knowledge).getByTestId("assistant-row-provenance")).toHaveTextContent("Fixed by Research editor");
    expect(within(knowledge).getByRole("menuitemradio", { name: /^Off/ })).toBeDisabled();
    // The base in force reads as chosen, not as unavailable.
    const base = within(knowledge).getByRole("menuitemcheckbox", { name: /Финансы 2026/ });
    expect(base).toBeEnabled();
    expect(base).toHaveAttribute("aria-disabled", "true");
    expect(base).toHaveAttribute("aria-checked", "true");
    fireEvent.click(base);
    expect(within(knowledge).queryByRole("menuitem", { name: "Override for this chat" })).toBeNull();
    fireEvent.keyDown(knowledge, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Change Skills mode" }));
    const skills = screen.getByRole("menu", { name: "Skills" });
    expect(within(skills).getByTestId("assistant-row-provenance")).toHaveTextContent("Fixed by Research editor");
    expect(within(skills).getByRole("menuitemradio", { name: /Auto · loads on demand/ }))
      .toHaveAttribute("aria-disabled", "true");
    expect(within(skills).getByRole("menuitemradio", { name: /Off · Always Skills only/ })).toBeDisabled();
    // Users still pin their own Skills on top of the Assistant's.
    expect(within(skills).getByRole("menuitem", { name: /Pin your Skills/ })).toBeEnabled();
    fireEvent.keyDown(skills, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("menuitem", { name: /Add Knowledge/ })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /Add Knowledge/ })).toHaveTextContent("Fixed by Research editor");

    expect(onSelectMcp).not.toHaveBeenCalled();
    expect(onSelectSkillsMode).not.toHaveBeenCalled();
    expect(onKnowledge).not.toHaveBeenCalled();
    expect(onSearch).not.toHaveBeenCalled();
  });

  it("opens every menu at its first line: on its first enabled choice, else on the menu itself", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      const { rerender } = render(<ComposerV2 {...props({
        assistant: galleryAssistant({ policies: ALL_FIXED }),
        onOpenMcpSettings: vi.fn(),
        onOpenSkillLibrary: vi.fn(),
        onSelectMcp: vi.fn(),
        onSelectSkillsMode: vi.fn()
      })} />);

      // Every choice is fixed: the menu itself takes focus, never a trailing
      // action, and focusing never scrolls the menu away from its first line.
      fireEvent.click(screen.getByRole("button", { name: "Change MCP mode" }));
      const tools = screen.getByRole("menu", { name: "MCP tools" });
      await waitFor(() => expect(tools).toHaveFocus());
      expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
      fireEvent.keyDown(tools, { key: "Escape" });

      fireEvent.click(screen.getByRole("button", { name: "Change Skills mode" }));
      const skills = screen.getByRole("menu", { name: "Skills" });
      await waitFor(() => expect(skills).toHaveFocus());
      expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
      // Tab still reaches the action after the choices.
      const pin = within(skills).getByRole("menuitem", { name: /Pin your Skills/ });
      for (let step = 0; step < 4 && document.activeElement !== pin; step += 1) {
        fireEvent.keyDown(document.activeElement ?? skills, { key: "Tab" });
      }
      expect(pin).toHaveFocus();
      fireEvent.keyDown(skills, { key: "Escape" });

      // An ordinary menu opens on its first choice.
      rerender(<ComposerV2 {...props({ onOpenMcpSettings: vi.fn(), onSelectMcp: vi.fn() })} />);
      fireEvent.click(screen.getByRole("button", { name: "Change MCP mode" }));
      const auto = within(screen.getByRole("menu", { name: "MCP tools" })).getByRole("menuitemradio", { name: /^Auto/ });
      await waitFor(() => expect(auto).toHaveFocus());
      expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    } finally {
      focus.mockRestore();
    }
  });

  it("changes an adjustable row for this chat and resets it to the Assistant", () => {
    const resetRow = vi.fn();
    const onSelectMcp = vi.fn();
    const { rerender } = render(<ComposerV2 {...props({
      assistant: galleryAssistant({}, resetRow),
      onSelectMcp
    })} />);

    fireEvent.click(screen.getByRole("button", { name: "Change MCP mode" }));
    let tools = screen.getByRole("menu", { name: "MCP tools" });
    expect(within(tools).getByTestId("assistant-row-provenance"))
      .toHaveTextContent("From Research editor · adjustable for this chat");
    const unchanged = within(tools).getByRole("menuitem", { name: /Reset to Assistant/ });
    expect(unchanged).toBeDisabled();
    expect(unchanged).toHaveTextContent("unchanged");
    // The Assistant's exact list is the chosen option; the user's modes follow
    // it, and choosing one is the change for this chat.
    const servers = within(tools).getByRole("menuitemradio", { name: /^Research editor's servers/ });
    expect(servers).toBeEnabled();
    expect(servers).toHaveAttribute("aria-checked", "true");
    expect(servers).toHaveTextContent("All tools of: office-compute");
    expect(within(tools).getByRole("menuitemradio", { name: /^Load all/ })).toHaveAttribute("aria-checked", "false");
    expect(within(tools).queryByRole("group", { name: "Included by the Assistant" })).toBeNull();
    expect(within(tools).queryByTestId("composer-v2-mcp-enabled")).toBeNull();
    fireEvent.click(within(tools).getByRole("menuitemradio", { name: /^Auto/ }));
    expect(onSelectMcp).toHaveBeenCalledWith({ mode: "auto" });

    rerender(<ComposerV2 {...props({
      assistant: galleryAssistant({ origins: { tools: "chat" }, values: { tools: { mode: "auto" } } }, resetRow),
      onSelectMcp
    })} />);
    const mcp = screen.getByRole("button", { name: "Change MCP mode" });
    expect(mcp).not.toHaveAttribute("data-provenance");
    fireEvent.click(mcp);
    tools = screen.getByRole("menu", { name: "MCP tools" });
    // The first line says what the chip says, and what the Assistant starts with.
    expect(within(tools).getByTestId("assistant-row-provenance"))
      .toHaveTextContent("Changed for this chat · Research editor starts with 1 server");
    expect(within(tools).getByRole("menuitemradio", { name: /^Auto/ })).toHaveAttribute("aria-checked", "true");
    expect(within(tools).queryByRole("menuitemradio", { name: /^Research editor.s servers/ })).toBeNull();
    // The user's own mode is in force: their enabled servers and Manage return.
    expect(within(tools).getByTestId("composer-v2-mcp-enabled")).toHaveTextContent("Enabled servers · 1");
    const reset = within(tools).getByRole("menuitem", { name: /Reset to Assistant/ });
    expect(reset).toHaveTextContent("Changed for this chat");
    fireEvent.click(reset);
    expect(resetRow).toHaveBeenCalledWith("tools");
    expect(screen.queryByRole("menu", { name: "MCP tools" })).toBeNull();
  });

  it("names at most three of the Assistant's servers and never one the user cannot see", () => {
    const servers = ["alpha", "bravo", "charlie", "delta"].map((name) => ({
      description: "", enabled: false, id: `mcp-${name}`, knownToolCount: 1, name, readiness: "ready" as const
    }));
    const assistant = galleryAssistant({
      assistantValues: {
        tools: { hiddenCount: 2, mode: "exact", serverIds: servers.map((server) => server.id) }
      }
    });
    render(<ComposerV2 {...props({
      assistant,
      config: { ...composerGalleryConfig, mcpServers: servers },
      initialLayer: "tools",
      onSelectMcp: vi.fn()
    })} />);

    expect(screen.getByRole("menuitemradio", { name: /^Research editor's servers/ }))
      .toHaveTextContent("All tools of: alpha, bravo, charlie and 3 more");
  });

  it("says in the chip's description what the menu's first line says, in every Assistant state", () => {
    const states = {
      adjustable: galleryAssistant(),
      changed: galleryAssistant({ origins: { tools: "chat" }, values: { tools: { mode: "auto" } } }),
      fallback: galleryAssistant({
        deviations: { tools: { reason: "tools_access" } },
        origins: { tools: "fallback" },
        values: { tools: { mode: "auto" } }
      }),
      fixed: galleryAssistant({ policies: { tools: "fixed" } })
    };
    const lines: Record<string, string> = {};
    for (const [state, assistant] of Object.entries(states)) {
      const { unmount } = render(<ComposerV2 {...props({ assistant, onSelectMcp: vi.fn() })} />);
      const chip = screen.getByRole("button", { name: "Change MCP mode" });
      const description = document.getElementById(chip.getAttribute("aria-describedby") ?? "")?.textContent ?? "";
      // "MCP: <value> · <provenance>": the provenance opens the menu's first line.
      const provenance = description.slice(description.indexOf(" · ") + 3);
      fireEvent.click(chip);
      const line = within(screen.getByRole("menu", { name: "MCP tools" }))
        .getByTestId("assistant-row-provenance").textContent ?? "";
      expect(line.startsWith(provenance), `${state}: "${description}" and "${line}"`).toBe(true);
      lines[state] = line;
      unmount();
    }
    expect(lines).toEqual({
      adjustable: "From Research editor · adjustable for this chat",
      changed: "Changed for this chat · Research editor starts with 1 server",
      fallback: "Research editor's MCP servers aren't available to you; using your default",
      fixed: "Fixed by Research editor"
    });
  });

  it("explains a fallback row and leaves an inherit row to the user", () => {
    render(<ComposerV2 {...props({
      assistant: galleryAssistant({
        assistantValues: { search: { mode: "inherit" } },
        deviations: { knowledge: { dependencies: [{ kind: "search", name: "HR handbook" }], reason: "knowledge_access" } },
        origins: { knowledge: "fallback", search: "default" },
        values: { search: { mode: "all_selected", optionIds: ["web-primary"] } }
      }),
      initialLayer: "knowledge",
      onSelectKnowledgeBaseIds: undefined,
      onSelectKnowledgeSelection: vi.fn()
    })} />);

    const knowledge = screen.getByRole("menu", { name: "Knowledge" });
    expect(within(knowledge).getByTestId("assistant-row-provenance"))
      .toHaveTextContent("Research editor's HR handbook isn't available to you; using your default");
    expect(within(knowledge).getByRole("menuitemradio", { name: /^Off/ })).toBeEnabled();
    expect(within(knowledge).queryByRole("menuitem", { name: /Reset to Assistant/ })).toBeNull();
    fireEvent.keyDown(knowledge, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: /^Choose web search/u }));
    const search = screen.getByRole("dialog", { name: "Web search" });
    expect(within(search).queryByTestId("assistant-row-provenance")).toBeNull();
    expect(within(search).queryByRole("button", { name: /Reset to Assistant/ })).toBeNull();
  });

  it("names the Project default, never a personal one, for a fallback row in a Project chat", () => {
    const overrideKnowledge = vi.fn();
    // The props the shell passes a Project chat's composer.
    render(<ComposerV2 {...props({
      assistant: galleryAssistant({
        assistantValues: { knowledge: { baseIds: [], hiddenCount: 1, mode: "explicit", sourceIds: [] } },
        deviations: { knowledge: { reason: "knowledge_access" } },
        origins: { knowledge: "fallback" },
        project: true
      }),
      config: composerGalleryProjectConfig,
      initialLayer: "knowledge",
      knowledgePlanSource: "project",
      onOverrideKnowledgePlan: overrideKnowledge,
      onSelectKnowledgeBaseIds: undefined,
      onSelectKnowledgeSelection: vi.fn(),
      selectedKnowledgeSelection: { baseIds: ["kb-launch"], mode: "explicit", sourceIds: [], version: 1 },
      sharedProject: true
    })} />);

    const knowledge = screen.getByRole("menu", { name: "Knowledge" });
    const line = within(knowledge).getByTestId("assistant-row-provenance");
    expect(line).toHaveTextContent("Research editor's Knowledge isn't available in this Project; using the Project default");
    // The fallback line is the only notice and carries the override.
    expect(within(knowledge).queryByText(/This Project controls the default Knowledge/)).toBeNull();
    expect(within(knowledge).getAllByRole("menuitem", { name: "Override for this chat" })).toHaveLength(1);
    fireEvent.click(within(line).getByRole("menuitem", { name: "Override for this chat" }));
    expect(overrideKnowledge).toHaveBeenCalledOnce();
    // The chip says where the Knowledge comes from once.
    expect(screen.getByRole("button", { name: "Choose Knowledge" })).toHaveAccessibleDescription(
      "Knowledge: Launch playbooks · Research editor's Knowledge isn't available in this Project; using the Project default"
    );
    // Only the Project's Knowledge is offered; never All my knowledge or a personal base.
    expect(within(knowledge).queryByText("All my knowledge")).toBeNull();
    expect(within(knowledge).getByText("Launch playbooks")).toBeVisible();
    expect(within(knowledge).queryByText("Финансы 2026")).toBeNull();
  });

  it("lists the Assistant's Skills read-only with their mode and lets the user pin on top", () => {
    const onOpenSkillLibrary = vi.fn();
    const onSelectSkillsMode = vi.fn();
    const manualSkill = {
      archived: false,
      description: "Checks claims",
      id: "skill-manual",
      instructionCharacterCount: 24,
      name: "Careful editor",
      owned: true,
      ownerDisplayName: "Viewer",
      scope: { kind: "owner" as const },
      updatedAt: "2026-08-16T00:00:00.000Z",
      version: 1
    };
    render(<ComposerV2 {...props({
      assistant: galleryAssistant(),
      config: { ...composerGalleryConfig, skills: [manualSkill] },
      onOpenSkillLibrary,
      onSelectSkillsMode,
      selectedSkillIds: [manualSkill.id],
      selectedSkills: [{ id: manualSkill.id, name: manualSkill.name }]
    })} />);

    const chip = screen.getByRole("button", { name: "Change Skills mode" });
    // The Assistant's Always Skill and the user's pin; On demand Skills are not pinned.
    expect(chip).toHaveAccessibleDescription("Skills: Auto · 2 pinned (always loaded) · From Research editor");
    fireEvent.click(chip);
    const skills = screen.getByRole("menu", { name: "Skills" });
    expect(within(skills).getByTestId("assistant-row-provenance"))
      .toHaveTextContent("From Research editor · adjustable for this chat");
    expect(within(skills).getByRole("menuitemradio", { name: "Auto · loads on demand" }))
      .toHaveAttribute("aria-checked", "true");
    const included = within(skills).getByRole("group", { name: "Included by the Assistant" });
    expect(included).toHaveTextContent("Policy citationsAlways");
    expect(included).toHaveTextContent("ChartsOn demand");
    expect(within(included).queryByRole("menuitemcheckbox")).toBeNull();
    expect(within(skills).getByRole("menuitem", { name: /Reset to Assistant/ })).toBeDisabled();
    fireEvent.click(within(skills).getByRole("menuitem", { name: /Pin your Skills/ }));
    expect(onOpenSkillLibrary).toHaveBeenCalledOnce();
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Off · Always Skills only" }));
    expect(onSelectSkillsMode).toHaveBeenCalledWith("off");
  });

  it("leaves final Skill budget admission to the server and counts only pinned dependencies", () => {
    const includedSkills = Array.from({ length: 30 }, (_, i) => ({ id: `included-${i}`, mode: "pinned" as const, name: `Included ${i}` }));
    const onSend = vi.fn();
    const assistant = galleryAssistant();
    const selection = props({ draft: "Keep this draft", onSend, onOpenSkillLibrary: vi.fn(),
      assistant: { ...assistant, current: { ...assistant.current!, includedSkills } as ComposerV2Assistant["current"] },
      selectedSkillIds: ["manual-a", "manual-b", "manual-c"] });
    const { rerender } = render(<ComposerV2 {...selection} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    expect(onSend).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Keep this draft");
    rerender(<ComposerV2 {...selection} selectedSkillIds={["included-0", "manual-a", "manual-b"]} />);
    expect(screen.getByRole("button", { name: "Change Skills mode" })).toHaveAccessibleDescription(/Skills: Auto · 32 pinned \(always loaded\)/);
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    rerender(<ComposerV2 {...selection} selectedSkillIds={[]} />);
    expect(screen.getByRole("button", { name: "Change Skills mode" })).toHaveAccessibleDescription(/Skills: Auto · 30 pinned \(always loaded\)/);
  });

  it("keeps loading, malformed, and zero-entitlement authority states explicit", () => {
    const retry = vi.fn();
    const { rerender } = render(<ComposerV2 {...props({ config: null, draft: "" })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading available capabilities…");
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();

    rerender(<ComposerV2 {...props({ config: null, configError: true, draft: "", onRetryConfig: retry })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load available capabilities.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();

    const empty: ComposerConfig = {
      ...composerGalleryConfig,
      catalog: {
        ...composerGalleryConfig.catalog,
        models: [],
        providers: []
      }
    };
    rerender(<ComposerV2 {...props({ config: empty, draft: "" })} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "No models available. Contact your administrator."
    );
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("does not offer Knowledge selection when no bases or documents exist", () => {
    const config: ComposerConfig = {
      ...composerGalleryConfig,
      knowledgeBases: [],
      knowledgeDocumentTotal: 0,
      knowledgeSources: []
    };
    render(<ComposerV2 {...props({
      config,
      initialLayer: "knowledge",
      onSelectKnowledgeBaseIds: undefined,
      onSelectKnowledgeSelection: vi.fn(),
      selectedKnowledgeBaseIds: []
    })} />);

    expect(screen.queryByRole("button", { name: "Choose Knowledge" })).toBeNull();
    expect(screen.queryByRole("menuitemradio", { name: /All my knowledge/i })).toBeNull();
    expect(screen.getByRole("menuitemcheckbox", { name: /Knowledge/ })).toBeDisabled();
  });

  it("searches eligible Sources beyond the initially loaded library page", async () => {
    const onSelectKnowledgeSelection = vi.fn();
    const onSearchKnowledgeSources = vi.fn().mockResolvedValue([{
      description: "A remotely matched source",
      id: "source-deep",
      name: "Deep archive",
      owned: true,
      readiness: "ready"
    }]);
    render(<ComposerV2 {...props({
      initialLayer: "knowledge",
      onSearchKnowledgeSources,
      onSelectKnowledgeBaseIds: undefined,
      onSelectKnowledgeSelection,
      selectedKnowledgeBaseIds: []
    })} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search Knowledge resources" }), {
      target: { value: "deep" }
    });
    await waitFor(() => expect(onSearchKnowledgeSources).toHaveBeenCalledWith("deep"));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Deep archive/ }));

    expect(onSelectKnowledgeSelection).toHaveBeenCalledWith({
      baseIds: [],
      mode: "explicit",
      sourceIds: ["source-deep"],
      version: 1
    });
  });

  it("groups bases and recent documents while keeping selected resources visible in search", async () => {
    const sources = Array.from({ length: 7 }, (_, index) => ({
      description: `Document ${index + 1}`,
      id: `source-${index + 1}`,
      name: index === 6 ? "Selected appendix" : `Recent document ${index + 1}`,
      owned: true,
      readiness: "ready" as const
    }));
    const onSelectKnowledgeSelection = vi.fn();
    render(<ComposerV2 {...props({
      config: {
        ...composerGalleryConfig,
        knowledgeDocumentTotal: 12,
        knowledgeSources: sources
      },
      initialLayer: "knowledge",
      onSelectKnowledgeBaseIds: undefined,
      onSelectKnowledgeSelection,
      selectedKnowledgeSelection: explicitKnowledgeSelection({
        baseIds: ["kb-finance"],
        sourceIds: ["source-7"]
      })
    })} />);

    expect(screen.getByRole("button", { name: "Choose Knowledge" }))
      .toHaveAccessibleDescription("Knowledge: Финансы 2026, Selected appendix");
    expect(screen.getByText("Bases")).toBeVisible();
    expect(screen.getByRole("menuitemcheckbox", { name: /Финансы 2026/ }))
      .toHaveTextContent("42 documents · ready");
    expect(screen.getByText("Single documents")).toBeVisible();
    expect(screen.getByRole("menuitemcheckbox", { name: /Selected appendix/ })).toBeVisible();
    expect(screen.getByText("Type to find any of your other 6 documents.")).toBeVisible();
    expect(screen.getByText("Applies to your next message.")).toBeVisible();
    expect(screen.getByRole("menuitemradio", { name: /All my knowledge/i }))
      .toHaveTextContent("12 files");

    fireEvent.change(screen.getByRole("searchbox", { name: "Search Knowledge resources" }), {
      target: { value: "no matches" }
    });
    expect(screen.getByRole("menuitemcheckbox", { name: /Финансы 2026/ })).toBeVisible();
    expect(screen.getByRole("menuitemcheckbox", { name: /Selected appendix/ })).toBeVisible();

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Selected appendix/ }));
    expect(onSelectKnowledgeSelection).toHaveBeenLastCalledWith(
      explicitKnowledgeSelection({ baseIds: ["kb-finance"] })
    );
  });

  it("counts a privacy-hidden Assistant plan and lets an adjustable row replace it", () => {
    const onSelectKnowledgeSelection = vi.fn();
    render(<ComposerV2 {...props({
      assistant: galleryAssistant({
        assistantValues: { knowledge: { baseIds: [], hiddenCount: 2, mode: "explicit", sourceIds: [] } }
      }),
      initialLayer: "knowledge",
      knowledgePlanSource: "assistant",
      onSelectKnowledgeBaseIds: undefined,
      onSelectKnowledgeSelection,
      selectedKnowledgeSelection: inheritedKnowledgeSelection("assistant")
    })} />);

    const chip = screen.getByRole("button", { name: "Choose Knowledge" });
    expect(chip).toHaveAttribute("data-provenance", "assistant");
    expect(chip).toHaveAccessibleDescription("Knowledge: 2 resources · From Research editor");
    const knowledge = screen.getByRole("menu", { name: "Knowledge" });
    expect(within(knowledge).getByTestId("assistant-row-provenance"))
      .toHaveTextContent("From Research editor · adjustable for this chat");
    const selected = within(knowledge).getByRole("menuitemcheckbox", { name: /Selected Knowledge/ });
    expect(selected).toHaveTextContent("2 resources");
    expect(selected).toHaveAttribute("aria-checked", "true");
    expect(selected).toHaveAttribute("aria-disabled", "true");
    expect(selected).toBeEnabled();
    // No group label repeats the first line's Assistant.
    expect(within(knowledge).queryByText("From Research editor")).toBeNull();
    // Reset follows the modes, before the lists of bases and documents.
    const reset = within(knowledge).getByRole("menuitem", { name: /Reset to Assistant/ });
    expect(selected.compareDocumentPosition(reset) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reset.compareDocumentPosition(within(knowledge).getByText("Bases")) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(within(knowledge).queryByRole("menuitem", { name: "Override for this chat" })).toBeNull();
    fireEvent.click(within(knowledge).getByRole("menuitemradio", { name: /^Off/ }));
    expect(onSelectKnowledgeSelection).toHaveBeenCalledWith(EMPTY_KNOWLEDGE_SELECTION);
    expect(document.body.textContent).not.toContain("assistant-research");
  });

  it("keeps Project Knowledge locked until override without exposing personal all-scope", () => {
    const overrideKnowledge = vi.fn();
    render(<ComposerV2 {...props({
      initialLayer: "knowledge",
      knowledgePlanSource: "project",
      onOverrideKnowledgePlan: overrideKnowledge,
      onSelectKnowledgeBaseIds: undefined,
      onSelectKnowledgeSelection: vi.fn(),
      selectedKnowledgeSelection: explicitKnowledgeSelection({ baseIds: ["kb-finance"] }),
      sharedProject: true
    })} />);

    expect(screen.getByRole("button", { name: "Choose Knowledge" }))
      .toHaveAccessibleDescription("Knowledge: Финансы 2026 · from Project");
    expect(screen.queryByRole("menuitemradio", { name: /All my knowledge/i }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: /Финансы 2026/ })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Override for this chat" }));
    expect(overrideKnowledge).toHaveBeenCalledOnce();
  });

  it("never renders opaque provider, model, Knowledge, or MCP bindings", () => {
    const { container } = render(<ComposerV2 {...props() } />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("openai-work");
    expect(text).not.toContain("kb-finance");
    expect(text).not.toContain("mcp-office");
  });

  it("keeps the picker to display names and provider marks without hosts", () => {
    const leakyConfig: ComposerConfig = {
      ...composerGalleryConfig,
      catalog: {
        ...composerGalleryConfig.catalog,
        providers: [{
          family: "openai",
          id: "openai-work",
          models: ["gpt-5.2", "gpt-5.2-mini"],
          name: "Custom OpenAI · provider.invalid · ref 0N0FNN"
        }, {
          family: "google",
          id: "google-work",
          models: ["gemini-3-pro"],
          name: "Google"
        }]
      }
    };
    render(<ComposerWithModelOpener config={leakyConfig} />);

    // The composer row carries no model trigger: the model lives in the header.
    expect(screen.getByTestId("composer-v2").querySelector("[aria-controls$='-model']")).toBeNull();
    const surface = screen.getByTestId("composer-v2").textContent ?? "";
    expect(surface).not.toContain("provider.invalid");
    expect(surface).not.toContain("ref 0N0FNN");
    expect(surface).not.toContain("Custom OpenAI");
    // Group headers carry the monochrome family mark (or a monogram for an
    // unknown family), always decorative.
    fireEvent.click(screen.getByRole("button", { name: "GPT-5.2" }));
    const layer = screen.getByRole("dialog", { name: "Choose model" });
    const marks = layer.querySelectorAll(".v2-composer-model-group h3 > .v2-provider-mark, .v2-composer-model-group h3 > .v2-monogram");
    expect(marks).toHaveLength(2);
    expect(marks[0]?.querySelector("use")).toHaveAttribute("href", "#v2-icon-provider-openai");
    expect(marks[0]).toHaveAttribute("aria-hidden", "true");
    expect(marks[1]?.textContent).toBe("G");
    expect(screen.getByRole("option", { name: /^GPT-5\.2Reasoning/ })).toBeVisible();
  });

  it("shows model capabilities as glyphs and keeps the Parameters footer", () => {
    const onOpenModelParameters = vi.fn();
    render(<ComposerV2 {...props({
      initialLayer: "model",
      modelParametersSummary: "Reasoning medium · Temp 1.0",
      onMakeModelDefault: vi.fn(),
      onOpenModelParameters
    })} />);

    const option = screen.getByRole("option", { name: /^GPT-5\.2Reasoning/ });
    const glyphs = within(option).getByTitle(
      "Reasoning · PDF and documents · Images · Web search · Tools · Streaming"
    );
    expect(glyphs.querySelectorAll("svg")).toHaveLength(5);
    // Each glyph names itself on hover (C9); the text stays out of the row.
    expect([...glyphs.querySelectorAll("svg title")].map((title) => title.textContent))
      .toEqual(["Reasoning", "PDF and documents", "Images", "Web search", "Tools"]);
    expect(within(option).queryByText("Web search", { ignore: "title" })).toBeNull();
    // The group heading carries the provider family mark, not a raw id.
    expect(
      screen.getByRole("heading", { level: 3, name: /OpenAI/ }).querySelector(".v2-provider-mark use")
    ).toHaveAttribute("href", "#v2-icon-provider-openai");

    expect(screen.getByText("Applies to your next message.")).toBeVisible();
    expect(screen.queryByText(/Каталог отфильтрован/)).toBeNull();

    const makeDefault = screen.getByRole("button", {
      name: "Make GPT-5.2 mini your default model"
    });
    expect(makeDefault).toHaveTextContent("Set as default");

    const parameters = screen.getByTestId("composer-v2-model-parameters");
    expect(parameters).toHaveTextContent("Reasoning medium · Temp 1.0");
    fireEvent.click(parameters);
    expect(onOpenModelParameters).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Choose model" })).toBeNull();
  });

  it("opens the model picker with the Assistant's model and resets a changed model (A-12)", () => {
    const resetRow = vi.fn();
    const onSelectModel = vi.fn();
    const onOpenModelParameters = vi.fn();
    const { rerender } = render(<ComposerWithModelOpener
      assistant={galleryAssistant({}, resetRow)}
      onOpenModelParameters={onOpenModelParameters}
      onSelectModel={onSelectModel}
    />);
    const trigger = screen.getByRole("button", { name: "GPT-5.2" });

    fireEvent.click(trigger);
    let picker = screen.getByRole("dialog", { name: "Choose model" });
    const line = within(picker).getByTestId("assistant-row-provenance");
    expect(line).toHaveTextContent("Recommended by Research editor — GPT-5.2");
    expect(line).toHaveTextContent("In use");
    expect(within(picker).queryByRole("button", { name: "Reset to Assistant" })).toBeNull();
    fireEvent.click(within(picker).getByRole("option", { name: /^GPT-5\.2 mini/ }));
    expect(onSelectModel).toHaveBeenCalledWith(expect.objectContaining({ modelId: "gpt-5.2-mini" }));

    // After the change the same line offers Reset; the parameters stay reachable.
    rerender(<ComposerWithModelOpener
      assistant={galleryAssistant({
        origins: { controls: "default", model: "chat" },
        values: { model: { mode: "model", modelId: "gpt-5.2-mini" } }
      }, resetRow)}
      onOpenModelParameters={onOpenModelParameters}
      onSelectModel={onSelectModel}
      selectedModelId="gpt-5.2-mini"
    />);
    fireEvent.click(trigger);
    picker = screen.getByRole("dialog", { name: "Choose model" });
    expect(within(picker).getByTestId("assistant-row-provenance"))
      .toHaveTextContent("Changed for this chat · Research editor starts with GPT-5.2");
    expect(within(picker).getByTestId("composer-v2-model-parameters")).toBeEnabled();
    fireEvent.click(within(picker).getByRole("button", { name: "Reset to Assistant" }));
    expect(resetRow).toHaveBeenCalledWith("model");
    expect(screen.queryByRole("dialog", { name: "Choose model" })).toBeNull();
  });

  it("opens a fixed model from the locked header button with only its Parameters row (A-14)", async () => {
    const onSelectModel = vi.fn();
    const onOpenModelParameters = vi.fn();
    const onMakeModelDefault = vi.fn();
    render(<ComposerWithLockedModelOpener
      assistant={galleryAssistant({ policies: { model: "fixed" } })}
      modelParametersSummary="Reasoning high · Temp 0.7"
      onMakeModelDefault={onMakeModelDefault}
      onOpenModelParameters={onOpenModelParameters}
      onSelectModel={onSelectModel}
    />);

    // The locked button keeps its name and lock, says why, and still opens.
    const trigger = screen.getByTestId("header-model-trigger");
    expect(trigger).toBeEnabled();
    expect(trigger).toHaveAttribute("data-locked");
    expect(trigger).toHaveAccessibleName("GPT-5.2");
    expect(trigger).toHaveAccessibleDescription("GPT-5.2 · fixed by Research editor");
    trigger.focus();
    fireEvent.click(trigger);

    const picker = screen.getByRole("dialog", { name: "Choose model" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(within(picker).getByTestId("assistant-row-provenance"))
      .toHaveTextContent("Fixed by Research editor — GPT-5.2");
    // No control of the fixed picker can change the model.
    expect(within(picker).queryByRole("searchbox")).toBeNull();
    expect(within(picker).queryByRole("listbox")).toBeNull();
    expect(within(picker).queryAllByRole("option")).toHaveLength(0);
    expect(within(picker).queryByRole("button", { name: /your default model/ })).toBeNull();
    const parameters = within(picker).getByTestId("composer-v2-model-parameters");
    expect(parameters).toHaveTextContent("ParametersReasoning high · Temp 0.7");
    expect(within(picker).getByText("Applies to your next message.")).toBeVisible();
    await waitFor(() => expect(parameters).toHaveFocus());

    // Escape returns focus to the header button.
    fireEvent.keyDown(picker, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Choose model" })).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("composer-v2-model-parameters"));
    expect(onOpenModelParameters).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Choose model" })).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(onSelectModel).not.toHaveBeenCalled();
    expect(onMakeModelDefault).not.toHaveBeenCalled();
  });

  it("explains an unavailable Assistant model and keeps the list", () => {
    const onSelectModel = vi.fn();
    render(<ComposerV2 {...props({
      assistant: galleryAssistant({
        assistantValues: { model: { mode: "model", modelId: null } },
        deviations: { model: { reason: "model_access" } },
        origins: { controls: "default", model: "fallback" }
      }),
      initialLayer: "model",
      onSelectModel
    })} />);
    expect(screen.getByTestId("assistant-row-provenance")).toHaveTextContent(
      "Research editor's recommended model isn't available to you; using your default"
    );
    expect(screen.getByRole("searchbox")).toBeVisible();
    fireEvent.click(screen.getByRole("option", { name: /^GPT-5\.2 mini/ }));
    expect(onSelectModel).toHaveBeenCalledWith(expect.objectContaining({ modelId: "gpt-5.2-mini" }));
  });

  it("accepts PDFs through picker, drop, and clipboard with one capability filter", () => {
    const onUploadFiles = vi.fn();
    const onRejectedFiles = vi.fn();
    render(<ComposerV2 {...props({ onRejectedFiles, onUploadFiles })} />);
    const pickerFile = new File(["pdf-picker"], "picker.pdf", { type: "application/pdf" });
    const droppedFile = new File(["pdf-drop"], "dropped.pdf", { type: "application/pdf" });
    const rejectedFile = new File(["binary"], "setup.exe", {
      type: "application/x-msdownload"
    });
    const pastedFile = new File(["pdf-paste"], "pasted.pdf", { type: "application/pdf" });
    const fileInput = screen.getByLabelText("Attach files") as HTMLInputElement;

    expect(fileInput.accept).toContain(".pdf");
    expect(fileInput.accept).toContain("application/pdf");

    fireEvent.change(fileInput, {
      target: { files: [pickerFile] }
    });
    fireEvent.drop(screen.getByTestId("composer-v2-surface"), {
      dataTransfer: {
        dropEffect: "copy",
        files: [droppedFile, rejectedFile],
        types: ["Files"]
      }
    });
    fireEvent.paste(screen.getByRole("textbox", { name: "Message" }), {
      clipboardData: { files: [pastedFile] }
    });

    expect(onUploadFiles).toHaveBeenNthCalledWith(1, [pickerFile]);
    expect(onUploadFiles).toHaveBeenNthCalledWith(2, [droppedFile]);
    expect(onRejectedFiles).toHaveBeenCalledWith([rejectedFile]);
    expect(onUploadFiles).toHaveBeenNthCalledWith(3, [pastedFile]);
  });

  it("exposes Workspace state, network policy, and its keyboard-operable toggle", () => {
    const onToggle = vi.fn();
    render(<ComposerV2 {...props({
      workspace: {
        available: true,
        busy: false,
        enabled: true,
        internetEnabled: false,
        loading: false,
        onToggle,
        sessionState: "ready"
      }
    })} />);

    const opener = screen.getByRole("button", { name: /Workspace details/ });
    expect(opener).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(opener);
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Workspace ready");
    expect(screen.getByRole("menu", { name: "Workspace" })).toHaveTextContent("Internet: Off");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Turn off Workspace/ }));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("explains an unavailable Workspace and accepts opaque files when available", () => {
    const unavailable = props({
      workspace: {
        available: false,
        busy: false,
        enabled: false,
        internetEnabled: null,
        loading: false,
        onToggle: vi.fn(),
        sessionState: null,
        unavailableReason: "model_tools_required"
      }
    });
    const { rerender } = render(<ComposerV2 {...unavailable} />);

    fireEvent.click(screen.getByRole("button", { name: /Workspace details/ }));
    const toggle = screen.getByRole("menuitemcheckbox", { name: /Turn on Workspace/ });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveTextContent("Workspace requires a model with tool support.");

    const onUploadFiles = vi.fn();
    const opaque = new File(["opaque"], "dataset.custom", {
      type: "application/x-custom"
    });
    rerender(<ComposerV2 {...props({
      attachmentPolicy: { documents: true, files: true, images: true, pdfs: true },
      onUploadFiles,
      workspace: {
        available: true,
        busy: false,
        enabled: true,
        internetEnabled: true,
        loading: false,
        onToggle: vi.fn(),
        sessionState: "not_started"
      }
    })} />);
    const input = screen.getByLabelText("Attach files") as HTMLInputElement;
    expect(input.accept).toBe("");
    fireEvent.change(input, { target: { files: [opaque] } });
    expect(onUploadFiles).toHaveBeenCalledWith([opaque]);
  });

  it("keeps draft editing available while a blocking row explains disabled Send", () => {
    const onSend = vi.fn();
    const failed = [{
      fileName: "scan.pdf",
      id: "attachment-failed",
      retryable: true,
      status: "failed" as const
    }];
    const { rerender } = render(<ComposerV2 {...props({
      attachmentItems: failed,
      draft: "Продолжить анализ",
      onRemoveAttachment: vi.fn(),
      onSend
    })} />);

    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" }))
      .toHaveAccessibleDescription(/Retry processing or remove/);

    rerender(<ComposerV2 {...props({
      attachmentItems: [{ fileName: "sales.csv", id: "ready", status: "ready" }],
      draft: "",
      onRemoveAttachment: vi.fn(),
      onSend
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("allows an attachment-only direct PDF after local parser failure", () => {
    const onSend = vi.fn();
    render(<ComposerV2 {...props({
      attachmentItems: [{
        blocksSend: false,
        detail: "Local text extraction failed. The original PDF will be sent directly to the selected provider.",
        fileName: "scan.pdf",
        id: "direct-pdf",
        status: "failed"
      }],
      draft: "",
      onSend
    })} />);

    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toBeEnabled();
    expect(screen.getByText(/The original PDF will be sent directly/u)).toBeVisible();
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("reports count capacity without silently dropping an accepted selection", () => {
    const onAttachmentCountLimitExceeded = vi.fn();
    const onUploadFiles = vi.fn();
    render(<ComposerV2 {...props({
      attachmentItems: [{
        fileName: "ready.csv",
        id: "ready",
        status: "ready"
      }, {
        fileName: "rejected.exe",
        id: "rejected",
        rejection: "unsupported_format",
        status: "rejected"
      }],
      config: {
        ...composerGalleryConfig,
        catalog: {
          ...composerGalleryConfig.catalog,
          attachmentLimits: {
            ...composerGalleryConfig.catalog.attachmentLimits!,
            maxCount: 1
          }
        }
      },
      onAttachmentCountLimitExceeded,
      onUploadFiles
    })} />);

    fireEvent.change(screen.getByLabelText("Attach files"), {
      target: { files: [new File(["new"], "new.txt", { type: "text/plain" })] }
    });

    expect(onUploadFiles).not.toHaveBeenCalled();
    expect(onAttachmentCountLimitExceeded).toHaveBeenCalledWith({
      attemptedCount: 2,
      currentCount: 1,
      maxCount: 1
    });
  });
});

describe("the composer's reasoning effort chip", () => {
  const LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"];
  const reasoning = (value = "high", onChange = vi.fn()) => ({ onChange, options: LEVELS, value });
  const chip = () => screen.getByRole("button", { name: /^Reasoning effort:/u });

  it("shows the raw level and changes it through a menu of the model's levels", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<ComposerV2 {...props({ reasoningEffort: reasoning("xhigh", onChange) })} />);
    expect(chip()).toHaveAccessibleName("Reasoning effort: xhigh");
    expect(chip()).toHaveAttribute("data-tooltip", "Reasoning effort: xhigh");
    expect(chip()).toHaveTextContent(/^xhigh$/u);
    expect(chip()).not.toHaveAttribute("data-provenance");
    expect(chip()).not.toHaveAttribute("data-locked");

    fireEvent.click(chip());
    expect(chip()).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "Reasoning effort" });
    const rows = within(menu).getAllByRole("menuitemradio");
    expect(rows.map((row) => row.textContent)).toEqual(LEVELS);
    expect(within(menu).getByRole("menuitemradio", { name: "xhigh" })).toHaveAttribute("aria-checked", "true");
    expect(menu).toHaveTextContent("Applies to your next message.");
    await waitFor(() => expect(rows[0]).toHaveFocus());

    // Choosing the level in force changes nothing and closes the menu.
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "xhigh" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu", { name: "Reasoning effort" })).toBeNull();
    await waitFor(() => expect(chip()).toHaveFocus());

    fireEvent.click(chip());
    fireEvent.click(within(screen.getByRole("menu", { name: "Reasoning effort" })).getByRole("menuitemradio", { name: "low" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("low");
    expect(screen.queryByRole("menu", { name: "Reasoning effort" })).toBeNull();

    // The chip shows what its owner holds, so a change from the Parameters dialog shows too.
    rerender(<ComposerV2 {...props({ reasoningEffort: reasoning("low", onChange) })} />);
    expect(chip()).toHaveAccessibleName("Reasoning effort: low");
    expect(chip()).toHaveTextContent(/^low$/u);
  });

  it("is absent for a model without a reasoning control and closes its menu with the level", () => {
    const { rerender } = render(<ComposerV2 {...props({ reasoningEffort: reasoning() })} />);
    fireEvent.click(chip());
    expect(screen.getByRole("menu", { name: "Reasoning effort" })).toBeVisible();

    rerender(<ComposerV2 {...props({ reasoningEffort: null })} />);
    expect(screen.queryByRole("button", { name: /^Reasoning effort/u })).toBeNull();
    // The layer never falls back to another menu's content.
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close menu" })).toBeNull();

    rerender(<ComposerV2 {...props({ reasoningEffort: { ...reasoning(), options: [] } })} />);
    expect(screen.queryByRole("button", { name: /^Reasoning effort/u })).toBeNull();
  });

  it("keeps the level visible and unchangeable during an active run", () => {
    const onChange = vi.fn();
    render(<ComposerV2 {...props({ activeRun: true, onStop: vi.fn(), runId: "run", reasoningEffort: reasoning("medium", onChange) })} />);
    expect(chip()).toBeDisabled();
    expect(chip()).toHaveAccessibleName("Reasoning effort: medium");
    expect(chip()).toHaveTextContent(/^medium$/u);
    fireEvent.click(chip());
    expect(screen.queryByRole("menu", { name: "Reasoning effort" })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("locks a level the Assistant fixes and marks it with the Assistant's dot", () => {
    const onChange = vi.fn();
    render(<ComposerV2 {...props({
      assistant: galleryAssistant({ policies: { controls: "fixed", model: "fixed" } }),
      reasoningEffort: reasoning("high", onChange)
    })} />);
    expect(chip()).toBeEnabled();
    expect(chip()).toHaveAttribute("data-locked", "true");
    expect(chip()).toHaveAttribute("data-provenance", "assistant");
    expect(chip()).toHaveAccessibleName("Reasoning effort: high");
    expect(chip()).toHaveAccessibleDescription("Fixed by Research editor");
    expect(chip()).toHaveAttribute("data-tooltip", "Reasoning effort: high · Fixed by Research editor");

    fireEvent.click(chip());
    const menu = screen.getByRole("menu", { name: "Reasoning effort" });
    expect(within(menu).getByTestId("assistant-row-provenance")).toHaveTextContent("Fixed by Research editor");
    const current = within(menu).getByRole("menuitemradio", { name: "high" });
    expect(current).toHaveAttribute("aria-checked", "true");
    expect(current).toHaveAttribute("aria-disabled", "true");
    for (const level of LEVELS.filter((level) => level !== "high")) {
      expect(within(menu).getByRole("menuitemradio", { name: level })).toBeDisabled();
    }
    fireEvent.click(current);
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "low" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("names the Assistant only where its parameters set the level for its own model", () => {
    const { rerender } = render(<ComposerV2 {...props({ assistant: galleryAssistant(), reasoningEffort: reasoning() })} />);
    expect(chip()).toHaveAttribute("data-provenance", "assistant");
    expect(chip()).not.toHaveAttribute("data-locked");
    expect(chip()).toHaveAccessibleDescription("From Research editor · adjustable for this chat");
    fireEvent.click(chip());
    const menu = screen.getByRole("menu", { name: "Reasoning effort" });
    expect(within(menu).getByTestId("assistant-row-provenance"))
      .toHaveTextContent("From Research editor · adjustable for this chat");
    expect(within(menu).getByRole("menuitemradio", { name: "low" })).toBeEnabled();
    fireEvent.keyDown(menu, { key: "Escape" });

    // Changed for this chat: no dot, the menu names the Assistant's level.
    rerender(<ComposerV2 {...props({
      assistant: galleryAssistant({ origins: { controls: "chat" } }),
      reasoningEffort: reasoning("low")
    })} />);
    expect(chip()).not.toHaveAttribute("data-provenance");
    expect(chip()).toHaveAccessibleDescription("Changed for this chat · Research editor starts with high");

    // Parameters without a level, or another model: the level is the user's own.
    rerender(<ComposerV2 {...props({
      assistant: galleryAssistant({ assistantValues: { controls: { temperature: 0.2 } } }),
      reasoningEffort: reasoning()
    })} />);
    expect(chip()).not.toHaveAttribute("data-provenance");
    expect(chip()).not.toHaveAccessibleDescription(/Research editor/u);
    rerender(<ComposerV2 {...props({
      assistant: galleryAssistant({ policies: { controls: "fixed", model: "fixed" } }),
      reasoningEffort: reasoning(),
      selectedModelId: "gpt-5.2-mini"
    })} />);
    expect(chip()).not.toHaveAttribute("data-provenance");
    expect(chip()).not.toHaveAttribute("data-locked");
    fireEvent.click(chip());
    expect(within(screen.getByRole("menu", { name: "Reasoning effort" })).getByRole("menuitemradio", { name: "low" }))
      .toBeEnabled();
  });

  it("sits after the tools and turns labels into icons only as the seventh chip", () => {
    const six = { agent: { enabled: false, onToggle: vi.fn() }, workspace: galleryWorkspace() };
    const { rerender } = render(<ComposerV2 {...props({ ...six, reasoningEffort: reasoning() })} />);
    const row = screen.getByLabelText("Active capabilities");
    const buttons = within(row).getAllByRole("button");
    expect(buttons.at(-1)).toBe(chip());
    expect(buttons.at(-2)).toBe(screen.getByRole("button", { name: "Change Skills mode" }));
    expect(row).toHaveAttribute("data-compact-labels", "true");

    // Five capabilities and the level keep their labels; so do six without it.
    rerender(<ComposerV2 {...props({ workspace: galleryWorkspace(), reasoningEffort: reasoning() })} />);
    expect(row).not.toHaveAttribute("data-compact-labels");
    rerender(<ComposerV2 {...props({ ...six, reasoningEffort: null })} />);
    expect(row).not.toHaveAttribute("data-compact-labels");
    // Pending comments count as a chip.
    rerender(<ComposerV2 {...props({
      comments: [{ id: "one", quote: "Fragment", text: "Comment" }],
      reasoningEffort: reasoning(),
      workspace: galleryWorkspace()
    })} />);
    expect(row).toHaveAttribute("data-compact-labels", "true");
  });
});
