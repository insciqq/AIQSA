"use client";

import type { CatalogSearchStrategy } from "@/lib/contracts/catalog";
import type { ComposerConfigKnowledgeBase } from "@/lib/contracts/composerConfig";
import {
  allMyKnowledgeSelection,
  explicitKnowledgeSelection,
  type KnowledgeSelection
} from "@/lib/contracts/knowledge";
import type { McpRunSelection } from "@/lib/contracts/mcp";
import { userImageModelErrorMessage, type ImageModelUnavailableReason, type UserImageModelOption } from "@/lib/contracts/imageModels";
import type { ShellComposerView } from "@/components/app-shell/powerAppShellV2Contracts";
import { UiV2Button } from "@/components/ui-v2";
import { SearchPlanPickerV2 } from "@/components/ui-v2/SearchPlanPickerV2";
import type { SearchPlan } from "@/lib/domain/search";
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { SettingsSelectV2 } from "./SettingsSelectV2";
import { SettingsRowV2 } from "./SettingsV2";

export type ChatDefaultImageModelView = NonNullable<NonNullable<ShellComposerView["chatDefaults"]>["imageModel"]>;

export type ChatDefaultMcpMode = McpRunSelection["mode"];

const MCP_MODES: readonly Readonly<{ label: string; mode: ChatDefaultMcpMode }>[] = [
  { label: "Auto", mode: "auto" },
  { label: "Load all", mode: "load_all" },
  { label: "Off", mode: "off" }
];

const ALL_MY_KNOWLEDGE = "all_my_knowledge";
const NO_KNOWLEDGE = "";

/** Segmented single choice with roving focus (same contract as the theme segment). */
export function SettingsSegmentV2<T extends string>({
  label,
  onChange,
  options,
  value
}: Readonly<{
  label: string;
  onChange(next: T): void;
  options: readonly Readonly<{ label: string; value: T }>[];
  value: T;
}>) {
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % options.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    if (next === null) return;
    event.preventDefault();
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <div className="v2-settings-segment" role="radiogroup" aria-label={label}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            aria-checked={selected}
            className="v2-settings-segment-option v2-focusable"
            data-selected={selected || undefined}
            key={option.value}
            role="radio"
            tabIndex={selected ? 0 : -1}
            type="button"
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

const ORGANIZATION_IMAGE_MODEL = "";

const IMAGE_MODEL_UNAVAILABLE: Record<ImageModelUnavailableReason, string> = {
  model_unavailable: "its provider model is turned off or removed",
  credential_unavailable: "its provider key is unavailable",
  verification_required: "it needs a new check by an administrator",
  parameters_invalid: "its organization settings need an update"
};

function imageModelCapability(model: UserImageModelOption): string {
  if (model.unavailableReason) return "Unavailable";
  return model.generation && model.editing ? "Creates and edits" : model.generation ? "Creates only" : "Edits only";
}

/**
 * Chat defaults › Image model: one published model for personal chats, or the
 * organization default. An unavailable model is never replaced; the row names
 * why and leaves the next choice to the user.
 */
export function ImageModelRowV2({ view }: Readonly<{ view: ChatDefaultImageModelView }>) {
  const { load, settings } = view;
  const requested = useRef(false);
  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    load();
  }, [load]);
  const models = settings?.models ?? [];
  const byId = (id: string | null) => models.find((model) => model.id === id) ?? null;
  const organizationDefault = byId(settings?.organizationDefaultId ?? null);
  const effective = byId(settings?.effective?.id ?? null);
  const selectedId = settings?.selectedId ?? null;
  const unpublished = settings !== null && models.length === 0;
  return (
    <SettingsRowV2
      description="Creates and edits images in your personal chats. Projects use the organization default."
      testId="settings-default-image-model"
      title="Image model"
    >
      {view.loadState === "error" && !settings ? <>
        <span className="v2-settings-row-description" role="status">Image models didn&apos;t load</span>
        <UiV2Button aria-label="Retry image models" onClick={() => load()}>Retry</UiV2Button>
      </> : unpublished ? (
        <span className="v2-settings-row-description" role="status">Not set up by your organization</span>
      ) : <div className="v2-image-model-control">
        <SettingsSelectV2
          disabled={!settings || view.saving}
          label="Image model"
          options={settings ? [
            ...(organizationDefault ? [{ label: `Organization default · ${organizationDefault.displayName}`, value: ORGANIZATION_IMAGE_MODEL }] : []),
            ...(selectedId && !byId(selectedId) ? [{ label: "Unavailable model", value: selectedId }] : []),
            ...models.map((model) => ({ label: model.displayName, sub: `${model.providerName} · ${imageModelCapability(model)}`, value: model.id }))
          ] : [{ label: "Loading…", value: ORGANIZATION_IMAGE_MODEL }]}
          value={selectedId ?? ORGANIZATION_IMAGE_MODEL}
          onChange={(next) => {
            if (next !== (selectedId ?? ORGANIZATION_IMAGE_MODEL)) view.select(next || null);
          }}
        />
        {effective?.unavailableReason ? <span className="v2-settings-row-description" role="status">
          {effective.displayName} is unavailable: {IMAGE_MODEL_UNAVAILABLE[effective.unavailableReason]}. Choose another model{selectedId && organizationDefault && !organizationDefault.unavailableReason ? " or the organization default" : ""}.
        </span> : null}
        {selectedId && effective?.unavailableReason && organizationDefault && !organizationDefault.unavailableReason
          ? <UiV2Button disabled={view.saving} onClick={() => view.select(null)}>Use organization default</UiV2Button>
          : null}
        {view.saveError ? <p className="v2-settings-error" role="alert">{userImageModelErrorMessage(view.saveError)}</p> : null}
      </div>}
    </SettingsRowV2>
  );
}

function knowledgeValue(plan: KnowledgeSelection | null): string {
  if (!plan || plan.mode === "none" || plan.mode === "inherited") return NO_KNOWLEDGE;
  if (plan.mode === "all_my_knowledge") return ALL_MY_KNOWLEDGE;
  return plan.baseIds[0] ?? NO_KNOWLEDGE;
}

/**
 * Chat defaults rows below Default model (PRD §4.9): Web search, MCP tools,
 * Knowledge and Image model. Each change persists the personal default only;
 * the open chat's composer keeps its own selection.
 */
export function ChatDefaultsRowsV2({
  imageModel,
  knowledgeBases,
  knowledgePlan,
  mcpMode,
  skillsMode = "auto",
  onSkillsMode,
  onKnowledgePlan,
  onMcpMode,
  onOpenMcp,
  onOpenSkills,
  onSearchPlan,
  onResetSearchPlan,
  searchPreferenceSource,
  searchPlan,
  searchStrategies
}: Readonly<{
  imageModel?: ChatDefaultImageModelView;
  knowledgeBases: readonly ComposerConfigKnowledgeBase[];
  knowledgePlan: KnowledgeSelection | null;
  mcpMode: ChatDefaultMcpMode;
  skillsMode?: "auto" | "off";
  onSkillsMode?(mode: "auto" | "off"): void;
  onKnowledgePlan(plan: KnowledgeSelection | null): void;
  onMcpMode(mode: ChatDefaultMcpMode): void;
  onOpenMcp?(): void;
  onOpenSkills?(): void;
  onSearchPlan(plan: SearchPlan): void;
  onResetSearchPlan?(): void;
  searchPreferenceSource?: "organization" | "personal";
  searchPlan: SearchPlan;
  searchStrategies: readonly CatalogSearchStrategy[];
}>) {
  const engines = searchStrategies.filter((strategy) => strategy.kind !== "none");
  const activeBases = knowledgeBases.filter((base) => !base.archived);
  const currentKnowledge = knowledgeValue(knowledgePlan);
  const orphanBaseId = currentKnowledge !== NO_KNOWLEDGE && currentKnowledge !== ALL_MY_KNOWLEDGE &&
    !activeBases.some((base) => base.id === currentKnowledge)
    ? currentKnowledge
    : null;

  return (
    <>
      <SettingsRowV2 description="Choose up to three sources and how they work together." testId="settings-default-search" title="Web search">
        <details className="v2-search-default-disclosure">
          <summary aria-label="Web search default">{searchPreferenceSource === "organization" ? "Organization default · " : ""}{searchPlan.optionIds.length ? `${searchPlan.optionIds.length} ${searchPlan.optionIds.length === 1 ? "source" : "sources"} selected` : "Off"}</summary>
          <SearchPlanPickerV2 options={engines} plan={searchPlan} onChange={onSearchPlan} onReset={onResetSearchPlan} scope="defaults" />
        </details>
      </SettingsRowV2>
      <SettingsRowV2 description={<>How a new chat discovers tools from your enabled servers. {onOpenMcp ? <button className="v2-studio-inline-link v2-focusable" onClick={onOpenMcp} type="button">MCP servers</button> : null}</>} testId="settings-default-mcp" title="MCP tools">
        <SettingsSegmentV2
          label="MCP tools default"
          options={MCP_MODES.map((option) => ({ label: option.label, value: option.mode }))}
          value={mcpMode}
          onChange={onMcpMode}
        />
      </SettingsRowV2>
      <SettingsRowV2 description={<>Let the model load your enabled Skills when useful. Pinned Skills are always included. {onOpenSkills ? <button className="v2-studio-inline-link v2-focusable" onClick={onOpenSkills} type="button">Skills</button> : null}</>} testId="settings-default-skills" title="Skills">
        <SettingsSegmentV2 label="Skills default" options={[{ label: "Auto", value: "auto" }, { label: "Off", value: "off" }]}
          value={skillsMode} onChange={mode => onSkillsMode?.(mode)} />
      </SettingsRowV2>
      <SettingsRowV2 description="Base attached to new chats by default." testId="settings-default-knowledge" title="Knowledge">
        <SettingsSelectV2
          label="Knowledge default"
          options={[
            { label: "None", value: NO_KNOWLEDGE },
            { label: "All my knowledge", value: ALL_MY_KNOWLEDGE },
            ...activeBases.map((base) => ({ label: base.name, value: base.id })),
            ...(orphanBaseId ? [{ label: "Unavailable base", value: orphanBaseId }] : [])
          ]}
          value={currentKnowledge}
          onChange={(next) => {
            onKnowledgePlan(
              next === NO_KNOWLEDGE
                ? null
                : next === ALL_MY_KNOWLEDGE
                  ? allMyKnowledgeSelection()
                  : explicitKnowledgeSelection({ baseIds: [next] })
            );
          }}
        />
      </SettingsRowV2>
      {imageModel ? <ImageModelRowV2 view={imageModel} /> : null}
    </>
  );
}
