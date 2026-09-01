"use client";

import type { CatalogSearchStrategy } from "@/lib/contracts/catalog";
import type { ComposerConfigKnowledgeBase } from "@/lib/contracts/composerConfig";
import {
  allMyKnowledgeSelection,
  explicitKnowledgeSelection,
  type KnowledgeSelection
} from "@/lib/contracts/knowledge";
import type { McpRunSelection } from "@/lib/contracts/mcp";
import type { SearchPlan } from "@/lib/domain/search";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { SettingsRowV2 } from "./SettingsV2";

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

function knowledgeValue(plan: KnowledgeSelection | null): string {
  if (!plan || plan.mode === "none" || plan.mode === "inherited") return NO_KNOWLEDGE;
  if (plan.mode === "all_my_knowledge") return ALL_MY_KNOWLEDGE;
  return plan.baseIds[0] ?? NO_KNOWLEDGE;
}

/**
 * Chat defaults rows below Default model (PRD §4.9): Web search, MCP tools and
 * Knowledge. Each change persists the personal default only; the open chat's
 * composer keeps its own selection.
 */
export function ChatDefaultsRowsV2({
  knowledgeBases,
  knowledgePlan,
  mcpMode,
  onKnowledgePlan,
  onMcpMode,
  onSearchPlan,
  searchPlan,
  searchStrategies
}: Readonly<{
  knowledgeBases: readonly ComposerConfigKnowledgeBase[];
  knowledgePlan: KnowledgeSelection | null;
  mcpMode: ChatDefaultMcpMode;
  onKnowledgePlan(plan: KnowledgeSelection | null): void;
  onMcpMode(mode: ChatDefaultMcpMode): void;
  onSearchPlan(plan: SearchPlan): void;
  searchPlan: SearchPlan;
  searchStrategies: readonly CatalogSearchStrategy[];
}>) {
  const engines = searchStrategies.filter((strategy) => strategy.kind !== "none");
  const searchValue = searchPlan.optionIds.find((id) => engines.some((engine) => engine.strategyId === id)) ?? "off";
  const searchOptions = [
    { label: "Off", value: "off" },
    ...engines.map((engine) => ({ label: engine.displayName, value: engine.strategyId }))
  ];
  const activeBases = knowledgeBases.filter((base) => !base.archived);
  const currentKnowledge = knowledgeValue(knowledgePlan);
  const orphanBaseId = currentKnowledge !== NO_KNOWLEDGE && currentKnowledge !== ALL_MY_KNOWLEDGE &&
    !activeBases.some((base) => base.id === currentKnowledge)
    ? currentKnowledge
    : null;

  return (
    <>
      <SettingsRowV2 description="Search engine offered first in new chats." testId="settings-default-search" title="Web search">
        <SettingsSegmentV2
          label="Web search default"
          options={searchOptions}
          value={searchValue}
          onChange={(next) => onSearchPlan({
            mode: "all_selected",
            optionIds: next === "off" ? [] : [next]
          })}
        />
      </SettingsRowV2>
      <SettingsRowV2 description="How a new chat discovers tools from your enabled servers." testId="settings-default-mcp" title="MCP tools">
        <SettingsSegmentV2
          label="MCP tools default"
          options={MCP_MODES.map((option) => ({ label: option.label, value: option.mode }))}
          value={mcpMode}
          onChange={onMcpMode}
        />
      </SettingsRowV2>
      <SettingsRowV2 description="Base attached to new chats by default." testId="settings-default-knowledge" title="Knowledge">
        <select
          aria-label="Knowledge default"
          value={currentKnowledge}
          onChange={(event) => {
            const next = event.target.value;
            onKnowledgePlan(
              next === NO_KNOWLEDGE
                ? null
                : next === ALL_MY_KNOWLEDGE
                  ? allMyKnowledgeSelection()
                  : explicitKnowledgeSelection({ baseIds: [next] })
            );
          }}
        >
          <option value={NO_KNOWLEDGE}>None</option>
          <option value={ALL_MY_KNOWLEDGE}>All my knowledge</option>
          {activeBases.map((base) => (
            <option key={base.id} value={base.id}>{base.name}</option>
          ))}
          {orphanBaseId ? <option value={orphanBaseId}>Unavailable base</option> : null}
        </select>
      </SettingsRowV2>
    </>
  );
}
