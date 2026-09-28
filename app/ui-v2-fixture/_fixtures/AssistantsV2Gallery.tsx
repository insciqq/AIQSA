"use client";

import {
  defaultAssistantDraftRows,
  type AssistantDraftRows,
  type AssistantEditorDraft,
  type AssistantEditorOptions,
  type AssistantEditorView,
  type AssistantNewAssistantView,
  type AssistantTemplatePrefill,
  type LibraryNotice
} from "@/components/assistants/libraryViewContracts";
import { DiscardChangesConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import {
  ASSISTANT_AVATAR_PALETTES,
  type AssistantAvatarRecipe,
  type AssistantRowKey
} from "@/lib/contracts/assistants";
import { UiV2Button } from "@/components/ui-v2";
import {
  AssistantEditorPageV2,
  assistantEditorTitle
} from "@/features/library-v2/assistants/editor/AssistantEditorPageV2";
import { NewAssistantSheetV2 } from "@/features/library-v2/assistants/editor/NewAssistantSheetV2";
import { LibraryV2 } from "@/features/library-v2/LibraryV2";
import { useState } from "react";
import {
  ASSISTANT_GALLERY_FIXTURE_STATES,
  AssistantsGalleryFixtureV2,
  type AssistantGalleryFixtureState
} from "./AssistantsGalleryFixtureV2";
import {
  ASSISTANT_SHARING_FIXTURE_STATES,
  AssistantsSharingFixtureV2,
  type AssistantSharingFixtureState
} from "./AssistantsSharingFixtureV2";

export const ASSISTANTS_GALLERY_STATES_V2 = [
  ...ASSISTANT_GALLERY_FIXTURE_STATES,
  "dirty",
  "editor",
  "editor-conflict",
  "editor-errors",
  "editor-new",
  "editor-setup-open",
  "editor-skills",
  "new-sheet",
  ...ASSISTANT_SHARING_FIXTURE_STATES
] as const;

export type AssistantsGalleryStateV2 = (typeof ASSISTANTS_GALLERY_STATES_V2)[number];

type EditorFixtureState = Extract<AssistantsGalleryStateV2, "dirty" | `editor${string}`>;

function isSharingState(state: string): state is AssistantSharingFixtureState {
  return (ASSISTANT_SHARING_FIXTURE_STATES as readonly string[]).includes(state);
}

const avatar: AssistantAvatarRecipe = {
  accents: [0, 4],
  backgroundShape: "circle",
  foregroundShape: "diamond",
  kind: "generated",
  paletteId: "ocean",
  recipeVersion: 1,
  rotations: [0, 2]
};

const editorOptions: Omit<AssistantEditorOptions, "onRetryKnowledge"> = {
  knowledgeBases: [
    { available: true, id: "base-api", name: "API contracts" },
    { available: true, id: "base-hr", name: "HR handbook" }
  ],
  knowledgeDataError: null,
  knowledgeDataState: "ready",
  knowledgeSources: [
    { available: true, id: "source-auth", name: "Authentication guide" },
    { available: false, id: "source-draft", name: "Rate limits draft" }
  ],
  mcpServers: [
    { enabled: true, id: "mcp-jira", name: "Jira", readiness: "ready" },
    { enabled: true, id: "mcp-confluence", name: "Confluence", readiness: "idle" },
    { enabled: true, id: "mcp-gitlab", name: "GitLab", readiness: "ready" },
    { enabled: true, id: "mcp-kubernetes", name: "Kubernetes", readiness: "needs_setup" },
    { enabled: false, id: "mcp-github", name: "GitHub", readiness: "disabled" }
  ],
  models: [{
    capabilities: { documentInputMode: "native_pdf", imageInput: true, reasoning: true, toolCalling: true },
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
  }, {
    capabilities: { documentInputMode: "pdf_text_extraction", imageInput: false, reasoning: false, toolCalling: true },
    controls: {
      background: { defaultValue: false, supported: false },
      maxOutputTokens: { defaultValue: 8192 },
      reasoningEffort: { defaultValue: "medium", options: [], supported: false },
      stream: { defaultValue: true, supported: true },
      temperature: { defaultValue: 0.7, maxValue: 1, minValue: 0, supported: true }
    },
    id: "model-flash",
    label: "Gemini 3.8 Flash",
    providerFamily: "gemini",
    providerLabel: "Google",
    supportsTools: true
  }],
  searchOptions: [{ id: "web", label: "Web Search" }, { id: "news", label: "News" }],
  selectedSkills: [
    { id: "skill-triage", name: "Issue triage" },
    { id: "skill-release", name: "Release notes" },
    { available: false, id: "skill-legacy", name: "Legacy changelog" }
  ]
};

const instructions = `# Role
You are the Jira desk for the platform team. Work only with the Jira and Confluence tools you have.

## Rules
- Before creating an issue, search for duplicates and show them.
- Quote issue keys as links; never invent keys.
- Summaries: status, owner, blockers, next step — in that order.`;

function savedRows(): AssistantDraftRows {
  const rows = defaultAssistantDraftRows();
  return {
    ...rows,
    controls: { policy: "adjustable", value: { ...rows.controls.value, reasoningEffort: "high", temperature: "0.3" } },
    model: { policy: "adjustable", value: { mode: "model", modelId: "model-luna" } },
    tools: { policy: "fixed", value: { mode: "exact", serverIds: ["mcp-jira", "mcp-confluence"] } }
  };
}

function savedDraft(): AssistantEditorDraft {
  return {
    answerRules: null,
    avatar,
    category: "productivity",
    description: "Creates, searches and summarizes Jira issues for the platform team.",
    name: "Jira desk",
    responseReminder: "Answer in English. Link every issue key.",
    rows: savedRows(),
    starterPrompts: [
      "Summarize the open blockers for PLAT this week",
      "Create a bug from this stack trace",
      "What did we ship in the last sprint?"
    ],
    systemPrompt: instructions
  };
}

function initialDraft(state: EditorFixtureState, prefill: AssistantTemplatePrefill = {}): AssistantEditorDraft {
  if (state === "editor-new") {
    return {
      answerRules: null,
      avatar: { ...avatar, foregroundShape: "hexagon", paletteId: "meadow" },
      category: null,
      description: "",
      name: "",
      responseReminder: "",
      starterPrompts: [],
      systemPrompt: "",
      ...prefill,
      rows: defaultAssistantDraftRows()
    };
  }
  const draft = savedDraft();
  if (state === "editor") {
    // A source the owner lost access to: the row names it, the chat uses the default.
    return {
      ...draft,
      rows: { ...draft.rows, search: { policy: "adjustable", value: { mode: "model_choice", optionIds: ["web", "news"] } } }
    };
  }
  if (state === "editor-conflict") {
    return { ...draft, description: "Creates, searches and summarizes Jira issues for the platform and SRE teams." };
  }
  if (state === "editor-errors") {
    return {
      ...draft,
      name: "",
      rows: {
        ...draft.rows,
        knowledge: { policy: "fixed", value: { mode: "inherit" } },
        tools: { policy: "fixed", value: { mode: "exact", serverIds: [] } }
      }
    };
  }
  if (state === "editor-skills") {
    return {
      ...draft,
      rows: {
        ...draft.rows,
        skills: {
          policy: "adjustable",
          value: {
            links: [
              { delivery: "always", skillId: "skill-triage" },
              { delivery: "on_demand", skillId: "skill-release" },
              { delivery: "on_demand", skillId: "skill-legacy" }
            ],
            mode: "auto"
          }
        }
      }
    };
  }
  if (state === "editor-setup-open") {
    return {
      ...draft,
      rows: {
        ...draft.rows,
        tools: { policy: "fixed", value: { mode: "exact", serverIds: ["mcp-jira", "mcp-confluence", "mcp-kubernetes"] } }
      }
    };
  }
  return draft;
}

/** What another session saved while the conflict state's draft was open. */
function latestSavedDraft(): AssistantEditorDraft {
  const draft = savedDraft();
  return {
    ...draft,
    name: "Jira desk (team)",
    rows: {
      ...draft.rows,
      controls: { policy: "adjustable", value: { ...draft.rows.controls.value, reasoningEffort: "" } },
      model: { policy: "fixed", value: { mode: "model", modelId: "model-flash" } }
    },
    systemPrompt: `${instructions}\n- Tag the on-call engineer on incidents.`
  };
}

/** States reached by a failed save of a changed draft compare it with the saved Assistant. */
function baselineDraft(state: EditorFixtureState, prefill?: AssistantTemplatePrefill): AssistantEditorDraft {
  return state === "editor-conflict" || state === "editor-errors" ? savedDraft() : initialDraft(state, prefill);
}

const expandedRows: Partial<Record<EditorFixtureState, AssistantRowKey>> = {
  "editor-errors": "tools",
  "editor-setup-open": "tools",
  "editor-skills": "skills"
};

function EditorFixture({ expandedRow, initialSharing, onClose, onTry, prefill, state }: Readonly<{
  expandedRow?: AssistantRowKey;
  /** The Sharing sheet open over the editor in this state. */
  initialSharing?: AssistantSharingFixtureState;
  onClose(): void;
  onTry(name: string): void;
  prefill?: AssistantTemplatePrefill;
  state: EditorFixtureState;
}>) {
  const [sharing, setSharing] = useState<AssistantSharingFixtureState | null>(initialSharing ?? null);
  const creating = state === "editor-new";
  const [baseline] = useState(() => JSON.stringify(baselineDraft(state, prefill)));
  const [draft, setDraft] = useState(() => initialDraft(state, prefill));
  const [forcedDirty, setForcedDirty] = useState(state === "dirty");
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState<LibraryNotice | null>(null);
  const [conflict, setConflict] = useState<AssistantEditorView["conflict"]>(state === "editor-conflict"
    ? { latest: { draft: latestSavedDraft(), version: 8 }, loading: false }
    : null);
  const [errors, setErrors] = useState<AssistantEditorView["errors"]>(state === "editor-errors"
    ? {
        fields: {
          name: "Enter a name.",
          starterPrompts: "Keep up to 6 starters of up to 200 characters."
        },
        rows: { tools: "Choose at least one MCP server, or turn Tools off." }
      }
    : null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const dirty = !saved && (forcedDirty || JSON.stringify(draft) !== baseline);
  const change = (next: AssistantEditorDraft) => {
    setDraft(next);
    setSaved(false);
    setErrors(null);
  };
  const save = async () => {
    setSaved(true);
    setForcedDirty(false);
    setConflict(null);
    setErrors(null);
    setNotice({ kind: "success", text: creating ? "Assistant created. It stays private until you share it." : "Saved. Future runs use these changes." });
    return "fixture-assistant";
  };
  const editor: AssistantEditorView = {
    archived: false,
    assistantId: creating ? null : "jira-desk",
    audience: creating ? null : { everyone: false, groupNames: ["Platform team"] },
    availability: { ok: true },
    conflict,
    dirty,
    draft,
    error: conflict
      ? { code: "assistant_version_conflict", text: "This assistant changed in another session." }
      : errors ? { code: "assistant_editor_invalid", text: "Review the highlighted fields." } : null,
    errors,
    initialExpandedRow: expandedRow ?? expandedRows[state] ?? null,
    justCreated: false,
    mode: creating ? "create" : "edit",
    onCancel: onClose,
    onChange: (update) => change({ ...draft, ...update }),
    onGenerateAvatar: () => {
      const next = ASSISTANT_AVATAR_PALETTES[(ASSISTANT_AVATAR_PALETTES.indexOf(draft.avatar.paletteId) + 3) % ASSISTANT_AVATAR_PALETTES.length]!;
      change({ ...draft, avatar: { ...draft.avatar, paletteId: next } });
    },
    onKeepDraftOverLatest: () => setConflict(null),
    onOpenMcpSettings: () => setNotice({ kind: "success", text: "MCP servers would open here." }),
    onOpenSharing: creating ? null : () => setSharing("sharing-groups"),
    onReloadLatest: () => undefined,
    onReplaceDraftWithLatest: () => {
      if (conflict?.latest) change(conflict.latest.draft);
      setConflict(null);
    },
    onRowChange: (key, update) => change({ ...draft, rows: { ...draft.rows, [key]: { ...draft.rows[key], ...update } } }),
    onSave: save,
    onSaveAndTry: async () => {
      await save();
      onTry(draft.name || "New assistant");
      return true;
    },
    onUseInChat: null,
    options: {
      ...editorOptions,
      onRetryKnowledge: () => undefined,
      searchOptions: state === "editor"
        ? editorOptions.searchOptions.filter((option) => option.id !== "news")
        : editorOptions.searchOptions
    },
    rowAvailability: state === "editor"
      ? { search: { dependencies: [{ kind: "search", name: "News" }], reason: "search_access" } }
      : {},
    savedName: creating ? null : savedDraft().name,
    saving: false,
    scope: creating ? null : { kind: "owner" }
  };
  const requestClose = () => {
    if (dirty) setConfirmingDiscard(true);
    else onClose();
  };
  return (
    <LibraryV2
      initialTab="assistants"
      onBack={onClose}
      subview={{
        backLabel: "Back to Assistants",
        key: "assistant-editor",
        label: assistantEditorTitle(editor),
        onBack: requestClose
      }}
      tabs={[{
        content: (
          <>
            <AssistantEditorPageV2
              busy={false}
              editor={editor}
              notice={notice}
              onDismissNotice={() => setNotice(null)}
              onOpenSharing={() => editor.onOpenSharing?.()}
              onRequestClose={requestClose}
            />
            {sharing ? (
              <AssistantsSharingFixtureV2
                key={sharing}
                state={sharing}
                onClose={() => setSharing(null)}
                onSaved={() => {
                  setSharing(null);
                  setNotice({ kind: "success", text: "Sharing updated." });
                }}
              />
            ) : null}
            {confirmingDiscard ? (
              <DiscardChangesConfirmationDialog
                label="assistant draft"
                onCancel={() => setConfirmingDiscard(false)}
                onConfirm={() => {
                  setConfirmingDiscard(false);
                  onClose();
                }}
              />
            ) : null}
          </>
        ),
        id: "assistants",
        label: "Assistants"
      }]}
    />
  );
}

export function AssistantsV2Gallery({
  state = "list"
}: Readonly<{ state?: AssistantsGalleryStateV2 }>) {
  const [editorState, setEditorState] = useState<EditorFixtureState | null>(
    isSharingState(state) ? "editor" : state === "dirty" || state.startsWith("editor") ? state as EditorFixtureState : null
  );
  const [sheetOpen, setSheetOpen] = useState(state === "new-sheet");
  const [start, setStart] = useState<{ expandedRow?: AssistantRowKey; prefill: AssistantTemplatePrefill }>({ prefill: {} });
  const [closed, setClosed] = useState(false);
  const [usedAssistant, setUsedAssistant] = useState<string | null>(null);
  const [startedWith, setStartedWith] = useState<string | null>(null);

  if (closed || usedAssistant || startedWith) {
    return (
      <main className="v2-library-fixture-return">
        <p>{usedAssistant
          ? `A Temporary chat with ${usedAssistant} is open.`
          : startedWith ? `A new chat with ${startedWith} is open.` : "The chat is open again."}</p>
        <UiV2Button onClick={() => { setClosed(false); setUsedAssistant(null); setStartedWith(null); }}>Open Assistants</UiV2Button>
      </main>
    );
  }

  if (editorState) {
    return (
      <EditorFixture
        expandedRow={start.expandedRow}
        initialSharing={isSharingState(state) ? state : undefined}
        key={editorState}
        prefill={start.prefill}
        state={editorState}
        onClose={() => setEditorState(null)}
        onTry={setUsedAssistant}
      />
    );
  }

  const newAssistant: AssistantNewAssistantView = {
    onBlank: () => setEditorState("editor-new"),
    onClose: () => setSheetOpen(false),
    onFromCurrentChat: () => setEditorState("editor-new"),
    onOpen: () => setSheetOpen(true),
    onTemplate: (prefill, options) => {
      setStart({ expandedRow: options?.expandedRow, prefill });
      setEditorState("editor-new");
    },
    open: sheetOpen
  };
  // Editor states return to the ordinary list.
  const galleryState = (ASSISTANT_GALLERY_FIXTURE_STATES as readonly string[]).includes(state)
    ? state as AssistantGalleryFixtureState
    : "list";
  return (
    <>
      <AssistantsGalleryFixtureV2
        state={galleryState}
        onClose={() => setClosed(true)}
        onFromCurrentChat={newAssistant.onFromCurrentChat}
        onNewAssistant={newAssistant.onOpen}
        onStartChat={setStartedWith}
      />
      <NewAssistantSheetV2 view={newAssistant} />
    </>
  );
}
