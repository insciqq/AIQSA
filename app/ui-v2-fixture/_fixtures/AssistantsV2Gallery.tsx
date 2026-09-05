"use client";

import type {
  AssistantEditorDraftState,
  AssistantEditorView,
  AssistantLibraryView
} from "@/components/assistants/libraryViewContracts";
import type { AssistantAvatarRecipe } from "@/lib/contracts/assistants";
import { UiV2Button } from "@/components/ui-v2";
import { AssistantLibraryV2 } from "@/features/library-v2/AssistantEditorV2";
import { AssistantsPanelV2, LibraryV2 } from "@/features/library-v2/LibraryV2";
import type { AssistantSummaryV2 } from "@/features/library-v2/contracts";
import { useEffect, useMemo, useState } from "react";

export type AssistantsGalleryStateV2 =
  | "advanced"
  | "dirty"
  | "editor"
  | "empty"
  | "error"
  | "list"
  | "loading";

const avatar: AssistantAvatarRecipe = {
  accents: [0, 4],
  backgroundShape: "circle",
  foregroundShape: "diamond",
  kind: "generated",
  paletteId: "ocean",
  recipeVersion: 1,
  rotations: [0, 2]
};

const assistantCards: readonly AssistantSummaryV2[] = [
  {
    archived: false,
    available: true,
    avatar,
    description: "Reviews authentication, validation and response shapes against the current API contract.",
    id: "api-reviewer",
    modelLabel: "GPT-5.6 Luna",
    name: "API Reviewer",
    owned: true,
    pinned: true,
  },
  {
    archived: false,
    available: true,
    description: "Turns research notes into short briefs with clear claims and source boundaries.",
    id: "research-editor",
    modelLabel: "Claude Sonnet 5",
    name: "Research editor",
    owned: false,
    ownerDisplayName: "Maya Chen",
  },
  {
    archived: false,
    available: false,
    description: "Checks repositories and prepares a release checklist.",
    id: "release-helper",
    modelLabel: "GPT-5.6 Terra",
    name: "Release helper",
    owned: true,
    unavailable: {
      action: { kind: "mcp-settings", label: "Fix in Settings…" },
      explanation: "GitHub is turned off or needs attention.",
      headline: "Needs the GitHub tools"
    }
  },
  {
    archived: false,
    available: false,
    description: "A shared assistant whose governed setup is no longer available to this account.",
    id: "contract-analyst",
    name: "Contract analyst",
    owned: false,
    ownerDisplayName: "Operations",
    unavailable: {
      explanation: "Ask the owner to update this assistant.",
      headline: "Required access unavailable"
    }
  }
];

function initialDraft(): AssistantEditorDraftState {
  return {
    avatar,
    backgroundMode: null,
    category: "coding",
    description: "Reviews authentication, validation and response shapes against the current API contract.",
    developerPrompt: "Prefer concrete findings over speculative rewrites.",
    knowledgeSelection: { baseIds: ["base-api"], mode: "explicit", sourceIds: [], version: 1 },
    maxOutputTokens: "",
    mcpServerIds: ["mcp-github"],
    name: "API Reviewer",
    providerModelId: "model-luna",
    reasoningEffort: "",
    reasoningMode: "",
    searchOptionIds: [],
    searchPlanMode: "model_choice",
    skillIds: [],
    starterPrompts: ["Review this route handler", "Check this API response"],
    streamMode: null,
    systemPrompt: "Review authentication, validation and response shapes. Cite the exact contract when one exists.",
    temperature: ""
  };
}

export function AssistantsV2Gallery({
  state = "list"
}: Readonly<{ state?: AssistantsGalleryStateV2 }>) {
  const startsInEditor = state === "advanced" || state === "dirty" || state === "editor";
  const [task, setTask] = useState<"editor" | "list">(
    startsInEditor ? "editor" : "list"
  );
  const [draft, setDraft] = useState(initialDraft);
  const [dirty, setDirty] = useState(state === "dirty");
  const [notice, setNotice] = useState<AssistantLibraryView["notice"]>(null);
  const [closed, setClosed] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [usedAssistant, setUsedAssistant] = useState<string | null>(null);

  useEffect(() => {
    if (state !== "advanced" || task !== "editor") return;
    const advanced = document.querySelector<HTMLDetailsElement>("[data-testid='assistant-advanced-settings']");
    if (advanced) advanced.open = true;
  }, [state, task]);

  const cards = useMemo(() => assistantCards.map((assistant) => (
    assistant.id === "api-reviewer" ? { ...assistant, pinned } : assistant
  )), [pinned]);

  const editor: AssistantEditorView = {
    availability: { ok: true },
    canPublishInstallation: false,
    dirty,
    draft,
    error: null,
    fieldErrors: null,
    justCreated: false,
    mode: "edit",
    onCancel: () => setTask("list"),
    onChange: (update) => {
      setDraft((current) => ({ ...current, ...update }));
      setDirty(true);
    },
    onGenerateAvatar: () => setDirty(true),
    onOpenMcpSettings: () => setNotice({ kind: "success", text: "MCP Settings would open here." }),
    onPublish: () => setNotice({ kind: "success", text: "Publication fixture action complete." }),
    onRevokePublication: () => undefined,
    onSave: () => {
      setDirty(false);
      setNotice({ kind: "success", text: "Saved. Future runs use these changes." });
    },
    onUseInChat: () => setUsedAssistant(draft.name),
    options: {
      knowledgeBases: [{ available: true, id: "base-api", name: "API contracts" }],
      knowledgeDataError: null,
      knowledgeDataState: "ready",
      knowledgeSources: [{ available: true, id: "source-auth", name: "Authentication guide" }],
      mcpServers: [{ enabled: true, id: "mcp-github", name: "GitHub", readiness: "ready" }],
      models: [{
        capabilities: {
          documentInputMode: "native_pdf",
          imageInput: true,
          reasoning: true,
          toolCalling: true
        },
        controls: {
          background: { defaultValue: false, supported: true },
          maxOutputTokens: { defaultValue: 4096, maxValue: 16384 },
          reasoningEffort: {
            defaultValue: "medium",
            options: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
            supported: true
          },
          reasoningMode: { defaultValue: "standard", options: ["standard", "pro"], supported: true },
          stream: { defaultValue: true, supported: true },
          temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
        },
        id: "model-luna",
        label: "GPT-5.6 Luna",
        providerFamily: "openai",
        providerLabel: "OpenAI",
        supportsTools: true
      }],
      onRetryKnowledge: () => undefined,
      onRetrySkills: () => undefined,
      searchOptions: [{ id: "web", label: "Web Search" }],
      skillDataError: null,
      skillDataState: "ready",
      skills: []
    },
    publications: [],
    publishableGroups: [{ id: "group-platform", name: "Platform team" }],
    saving: false
  };

  const view: AssistantLibraryView = {
    busy: false,
    catalogError: null,
    catalogState: "ready",
    editor: task === "editor" ? editor : null,
    list: {
      assistants: [],
      onArchiveToggle: () => undefined,
      onDuplicate: () => undefined,
      onEdit: () => setTask("editor"),
      onNewAssistant: () => setTask("editor"),
      onPinToggle: () => setPinned((current) => !current),
      onUse: () => undefined
    },
    notice,
    onBackToChat: () => setClosed(true),
    onDismissNotice: () => setNotice(null),
    onRetryCatalog: () => undefined,
    task
  };

  if (closed || usedAssistant) {
    return (
      <main className="v2-library-fixture-return">
        <p>{usedAssistant ? `${usedAssistant} is applied to the next message.` : "The chat is open again."}</p>
        <UiV2Button onClick={() => { setClosed(false); setUsedAssistant(null); }}>Open Library</UiV2Button>
      </main>
    );
  }

  const loadState = state === "loading" ? "loading" : state === "error" ? "error" : "ready";
  const visibleCards = state === "empty" || loadState !== "ready" ? [] : cards;
  const listContent = (
    <AssistantsPanelV2
      assistants={visibleCards}
      error={state === "error" ? "We could not load Assistants. Nothing was changed." : null}
      loadState={loadState}
      onArchiveToggle={() => undefined}
      onCreate={() => setTask("editor")}
      onCreateFromCurrentSetup={() => setTask("editor")}
      onDuplicate={() => setNotice({ kind: "success", text: "Assistant duplicated." })}
      onOpen={() => setTask("editor")}
      onPinToggle={() => setPinned((current) => !current)}
      onRetry={() => setNotice({ kind: "success", text: "Retry requested." })}
      onUnavailableAction={(_, action) => setNotice({ kind: "success", text: action === "mcp-settings" ? "MCP Settings would open here." : "Assistant editor opened." })}
      onUse={(id) => setUsedAssistant(cards.find((assistant) => assistant.id === id)?.name ?? "Assistant")}
    />
  );
  const content = task === "list"
    ? listContent
    : <AssistantLibraryV2 view={view} />;

  return (
    <LibraryV2
      initialTab="assistants"
      onBack={() => setClosed(true)}
      subview={task === "list" ? null : {
        backLabel: "Back to Assistants",
        key: "assistant-editor",
        label: draft.name,
        onBack: editor.onCancel
      }}
      tabs={[{ content, id: "assistants", label: "Assistants" }]}
    />
  );
}
