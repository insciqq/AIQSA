import type { AssistantSummary } from "@/lib/contracts/assistants";
import type { CatalogModel } from "@/lib/contracts/catalog";
import { SKILL_MAX_PINNED } from "@/lib/contracts/skills";
import { assistantBylineV2 } from "../AssistantPickerV2";
import type { ComposerPaletteEntry } from "./paletteModel";

/** A Skill the palette can pin, as the Skill library (or the Project's Skills) lists it. */
export type ComposerPaletteSkill = Readonly<{ id: string; name: string; description: string }>;

/**
 * The Skills the shell hands the palette: the personal Skill library or the
 * Project's Skills, the load state of that list, and the library's own
 * "Always use" pin. `search` asks the library for Skills beyond its first page.
 */
export type ComposerPaletteSkillSource = Readonly<{
  items: readonly ComposerPaletteSkill[];
  state: "error" | "idle" | "loading" | "ready";
  pin(skillId: string): void;
  search?(query: string): void;
}>;

/** The header Assistant selector's choices and actions, as the palette reuses them. */
export type ComposerPaletteAssistantSource = Readonly<{
  items: readonly AssistantSummary[];
  currentId: string | null;
  /** A chat update of the Assistant is in flight. */
  pending: boolean;
  choose(assistantId: string): void;
  /** Opens the header's Assistant picker. */
  openPicker(): void;
  /** Loads the Assistant list when it has not been loaded yet. */
  load?(): void;
}>;

/** One availability-carrying composer action: its handler and the reason it is blocked, if any. */
type PaletteAction = Readonly<{ disabledReason: string | null; detail?: string | null; run(): void }>;

export type ComposerPaletteActionsInput = Readonly<{
  /** "+" → Create artifact. */
  artifact: PaletteAction;
  /** "+" → Attach files (the file dialog). */
  attach: PaletteAction;
  /** "+" → Skills… (the Skill library). */
  skillLibrary: PaletteAction | null;
  /** "+" → Add Knowledge… (the Knowledge layer). */
  knowledge: PaletteAction | null;
  /** Knowledge layer rows: each base toggles like its row. */
  knowledgeBases: readonly (PaletteAction & Readonly<{ id: string; name: string; selected: boolean; current: boolean }>)[];
  /** The MCP chip (its layer). */
  mcp: PaletteAction;
  /** The Search chip (its layer) and its "Turn off search". */
  search: PaletteAction | null;
  searchOff: PaletteAction | null;
  /** The Workspace layer's on/off row. */
  workspace: (PaletteAction & Readonly<{ enabled: boolean }>) | null;
  /** The Agent chip's toggle. */
  agent: (PaletteAction & Readonly<{ enabled: boolean }>) | null;
}>;

export type ComposerPaletteModelsInput = Readonly<{
  models: readonly CatalogModel[];
  providerNames: ReadonlyMap<string, string>;
  selectedModelId: string;
  selectedProvider: string;
  /** Set when the Assistant fixes the model: every model is listed with it. */
  fixedReason: string | null;
  select(model: CatalogModel): void;
}>;

export type ComposerPaletteSkillsInput = Readonly<{
  source: ComposerPaletteSkillSource;
  /** Pinned by the user ("Always use"). */
  pinnedIds: readonly string[];
  /** Always included by the chat's Assistant, and its name. */
  assistantAlwaysIds: readonly string[];
  assistantName: string | null;
  /** Every Skill in force (Assistant plus pinned), which the pin limit counts. */
  effectiveIds: readonly string[];
}>;

function skillEntries(input: ComposerPaletteSkillsInput): ComposerPaletteEntry[] {
  const pinned = new Set(input.pinnedIds);
  const fromAssistant = new Set(input.assistantAlwaysIds);
  const atLimit = input.effectiveIds.length >= SKILL_MAX_PINNED;
  return input.source.items.map((skill) => {
    const included = fromAssistant.has(skill.id);
    const isPinned = pinned.has(skill.id);
    const current = included || isPinned;
    const disabledReason = current
      ? null
      : atLimit
        ? `Up to ${SKILL_MAX_PINNED} Skills can be pinned. Remove one before pinning this Skill.`
        : null;
    return {
      id: `skill:${skill.id}`,
      section: "skills",
      label: skill.name,
      detail: included
        ? `Always used by ${input.assistantName ?? "the Assistant"}`
        : isPinned
          ? "Pinned · Always use"
          : skill.description ? `Always use · ${skill.description}` : "Always use",
      keywords: skill.description ? [skill.description] : [],
      icon: "wand",
      checked: current,
      current,
      disabledReason,
      run: () => input.source.pin(skill.id)
    } satisfies ComposerPaletteEntry;
  });
}

function actionEntries(input: ComposerPaletteActionsInput): ComposerPaletteEntry[] {
  const entries: ComposerPaletteEntry[] = [];
  const add = (
    id: string,
    label: string,
    icon: ComposerPaletteEntry["icon"],
    action: PaletteAction,
    keywords: readonly string[] = [],
    extra: Partial<ComposerPaletteEntry> = {}
  ) => entries.push({
    id: `action:${id}`,
    section: "actions",
    label,
    icon,
    keywords,
    detail: action.detail ?? null,
    disabledReason: action.disabledReason,
    run: action.run,
    ...extra
  });
  if (input.knowledge) add("knowledge", "Choose Knowledge…", "book", input.knowledge, ["knowledge", "documents", "bases"]);
  for (const base of input.knowledgeBases) {
    add(`knowledge-base:${base.id}`, base.name, "library", base, ["knowledge"], {
      checked: base.selected,
      current: base.current,
      queryOnly: true
    });
  }
  add("mcp", "MCP tools…", "tool", input.mcp, ["mcp", "tools", "servers"]);
  if (input.search) add("search", "Web search…", "globe", input.search, ["web", "search", "internet"]);
  if (input.searchOff) add("search-off", "Turn off web search", "globe", input.searchOff, ["web", "search"]);
  if (input.workspace) {
    add("workspace", input.workspace.enabled ? "Turn off Workspace" : "Turn on Workspace", "monitor",
      input.workspace, ["workspace", "sandbox", "code"]);
  }
  if (input.agent) {
    add("agent", input.agent.enabled ? "Turn off Agent" : "Turn on Agent", "bot", input.agent, ["agent", "codex"]);
  }
  add("artifact", "Create artifact", "artifact", input.artifact, ["artifact", "page", "slides", "game", "chart"]);
  add("attach", "Attach files", "attach", input.attach, ["attach", "files", "upload"]);
  if (input.skillLibrary) add("skill-library", "Skills…", "wand", input.skillLibrary, ["skills", "library", "pin"]);
  return entries;
}

function modelEntries(input: ComposerPaletteModelsInput): ComposerPaletteEntry[] {
  return input.models.map((model) => {
    const providerName = input.providerNames.get(model.provider) ?? model.provider;
    const current = model.modelId === input.selectedModelId && model.provider === input.selectedProvider;
    return {
      id: `model:${model.provider}:${model.modelId}`,
      section: "models",
      label: model.displayName,
      detail: current ? `${providerName} · Current model` : providerName,
      keywords: [providerName, model.upstreamModelId ?? ""].filter(Boolean),
      checked: current,
      current,
      disabledReason: current ? null : input.fixedReason,
      run: () => input.select(model)
    } satisfies ComposerPaletteEntry;
  });
}

function assistantEntries(source: ComposerPaletteAssistantSource): ComposerPaletteEntry[] {
  const pendingReason = source.pending ? "Updating the Assistant…" : null;
  const entries: ComposerPaletteEntry[] = source.items.filter((assistant) => !assistant.archived).map((assistant) => {
    const current = assistant.id === source.currentId;
    const byline = assistantBylineV2({
      owned: assistant.owned,
      ownerDisplayName: assistant.ownerDisplayName,
      projectName: assistant.scope.kind === "project" ? assistant.scope.projectName : undefined
    });
    return {
      id: `assistant:${assistant.id}`,
      section: "assistants",
      label: assistant.name,
      detail: current ? `${byline} · In this chat` : byline,
      keywords: [assistant.description, assistant.ownerDisplayName],
      icon: "assistant",
      checked: current,
      current,
      disabledReason: current
        ? null
        : !assistant.availability.ok
          ? assistant.owned ? "Needs attention" : "Not available to you"
          : pendingReason,
      run: () => source.choose(assistant.id)
    } satisfies ComposerPaletteEntry;
  });
  entries.push({
    id: "assistant:picker",
    section: "assistants",
    label: "Choose an Assistant…",
    detail: "Browse every Assistant",
    keywords: ["assistant"],
    icon: "assistant",
    disabledReason: pendingReason,
    run: source.openPicker
  });
  return entries;
}

/**
 * Every palette entry in section order: Skills, the composer's actions,
 * models, Assistants, then entries registered from outside the composer.
 */
export function buildComposerPaletteEntries(input: Readonly<{
  skills: ComposerPaletteSkillsInput | null;
  actions: ComposerPaletteActionsInput;
  models: ComposerPaletteModelsInput | null;
  assistants: ComposerPaletteAssistantSource | null;
  extra?: readonly ComposerPaletteEntry[];
}>): ComposerPaletteEntry[] {
  return [
    ...(input.skills ? skillEntries(input.skills) : []),
    ...actionEntries(input.actions),
    ...(input.models ? modelEntries(input.models) : []),
    ...(input.assistants ? assistantEntries(input.assistants) : []),
    ...(input.extra ?? [])
  ];
}
