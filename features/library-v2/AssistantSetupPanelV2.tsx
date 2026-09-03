"use client";

import { mcpReadinessPresentation } from "@/components/app-shell/mcpReadiness";
import type { AssistantEditorView } from "@/components/assistants/libraryViewContracts";
import {
  UiV2Button,
  UiV2Icon,
  UiV2ProviderMark,
  type UiV2IconName
} from "@/components/ui-v2";
import {
  explicitKnowledgeSelection,
  KNOWLEDGE_SELECTION_MAX_EXPLICIT_RESOURCES
} from "@/lib/contracts/knowledge";
import { isMcpReadinessStartable } from "@/lib/contracts/mcp";
import { SKILL_MAX_SELECTED, type SkillSummary } from "@/lib/contracts/skills";
import { MAX_SEARCH_PLAN_OPTIONS } from "@/lib/domain/search";
import { useState, type ReactNode } from "react";

function skillScopeLabel(skill: SkillSummary): string {
  if (skill.owned) return "Yours";
  if (skill.scope.kind === "workspace") {
    return skill.scope.workspaceNames.join(", ") || "Shared workspace";
  }
  return "Shared with everyone";
}

function joinedSummary(labels: readonly string[], empty = "None"): string {
  if (labels.length === 0) return empty;
  if (labels.length === 1) return labels[0]!;
  return `${labels.length} selected`;
}

function SetupRowV2({
  children,
  icon,
  label,
  onToggle,
  open,
  summary
}: Readonly<{
  children: ReactNode;
  icon: UiV2IconName;
  label: string;
  onToggle(): void;
  open: boolean;
  summary: string;
}>) {
  const panelId = `assistant-setup-${label.toLocaleLowerCase().replaceAll(" ", "-")}`;
  return (
    <section className="v2-assistant-setup-resource" data-open={open || undefined}>
      <div className="v2-assistant-setup-row">
        <UiV2Icon name={icon} />
        <span>
          <strong>{label}</strong>
          <small>{summary}</small>
        </span>
        <UiV2Button
          aria-controls={panelId}
          aria-expanded={open}
          onClick={onToggle}
        >
          {summary === "None" || summary === "Off" ? "Choose" : "Change"}
        </UiV2Button>
      </div>
      {open ? <div className="v2-assistant-setup-choices" id={panelId}>{children}</div> : null}
    </section>
  );
}

function ChoiceStateV2({
  error,
  loading,
  onRetry,
  resource
}: Readonly<{
  error: string | null;
  loading: boolean;
  onRetry(): void;
  resource: string;
}>) {
  if (loading) return <p role="status">Loading {resource}…</p>;
  if (!error) return null;
  return (
    <div className="v2-assistant-field-message" data-tone="error" role="alert">
      <span>{error}</span>
      <UiV2Button onClick={onRetry}>Try again</UiV2Button>
    </div>
  );
}

export function AssistantSetupPanelV2({
  editor,
  locked
}: Readonly<{
  editor: AssistantEditorView;
  locked: boolean;
}>) {
  const [openResource, setOpenResource] = useState<"knowledge" | "search" | "skills" | "tools" | null>(null);
  const { draft, options } = editor;
  const selectedModel = options.models.find((model) => model.id === draft.providerModelId) ?? null;
  const selectedKnowledgeBaseIds = draft.knowledgeSelection.baseIds;
  const selectedKnowledgeSourceIds = draft.knowledgeSelection.sourceIds;
  const selectedKnowledgeCount = selectedKnowledgeBaseIds.length + selectedKnowledgeSourceIds.length;
  const knowledgeLabels = [
    ...selectedKnowledgeBaseIds.map((id) => options.knowledgeBases.find((item) => item.id === id)?.name ?? "Unavailable base"),
    ...selectedKnowledgeSourceIds.map((id) => options.knowledgeSources.find((item) => item.id === id)?.name ?? "Unavailable document")
  ];
  const selectedMcpLabels = draft.mcpServerIds.map((id) =>
    options.mcpServers.find((item) => item.id === id)?.name ?? "Unavailable MCP server"
  );
  const selectedSearchLabels = draft.searchOptionIds.map((id) =>
    options.searchOptions.find((item) => item.id === id)?.label ?? "Unavailable Search source"
  );
  const selectedSkillLabels = draft.skillIds.map((id) =>
    options.skills.find((item) => item.id === id)?.name ?? "Unavailable Skill"
  );
  const capabilityLine = selectedModel ? [
    selectedModel.capabilities.reasoning ? "Reasoning" : null,
    selectedModel.capabilities.toolCalling ? "tools" : null,
    selectedModel.capabilities.documentInputMode !== "none" ? "files" : null,
    selectedModel.capabilities.imageInput ? "images" : null
  ].filter((value): value is string => Boolean(value)).join(" · ") : "Choose a model to continue";

  const toggleResource = (resource: Exclude<typeof openResource, null>) => {
    setOpenResource((current) => current === resource ? null : resource);
  };
  const toggleKnowledgeBase = (baseId: string, checked: boolean) => editor.onChange({
    knowledgeSelection: explicitKnowledgeSelection({
      baseIds: checked
        ? [...selectedKnowledgeBaseIds, baseId]
        : selectedKnowledgeBaseIds.filter((id) => id !== baseId),
      sourceIds: selectedKnowledgeSourceIds
    })
  });
  const toggleKnowledgeSource = (sourceId: string, checked: boolean) => editor.onChange({
    knowledgeSelection: explicitKnowledgeSelection({
      baseIds: selectedKnowledgeBaseIds,
      sourceIds: checked
        ? [...selectedKnowledgeSourceIds, sourceId]
        : selectedKnowledgeSourceIds.filter((id) => id !== sourceId)
    })
  });
  const toggleMcpServer = (serverId: string, checked: boolean) => editor.onChange({
    mcpServerIds: checked
      ? [...draft.mcpServerIds, serverId]
      : draft.mcpServerIds.filter((id) => id !== serverId)
  });
  const toggleSearchOption = (optionId: string, checked: boolean) => editor.onChange({
    searchOptionIds: checked
      ? [...draft.searchOptionIds, optionId]
      : draft.searchOptionIds.filter((id) => id !== optionId)
  });
  const toggleSkill = (skillId: string, checked: boolean) => editor.onChange({
    skillIds: checked
      ? [...draft.skillIds, skillId]
      : draft.skillIds.filter((id) => id !== skillId)
  });

  return (
    <aside className="v2-assistant-setup" aria-labelledby="assistant-setup-heading">
      <header>
        <h2 id="assistant-setup-heading">Setup</h2>
        <p>What it runs with.</p>
      </header>

      <div className="v2-assistant-model-field" data-invalid={Boolean(editor.fieldErrors?.providerModelId) || undefined}>
        <label htmlFor="assistant-editor-model">Model</label>
        <span className="v2-assistant-model-select">
          {selectedModel ? (
            <UiV2ProviderMark
              family={selectedModel.providerFamily}
              label={selectedModel.providerLabel}
            />
          ) : <UiV2Icon name="sliders" />}
          <select
            aria-describedby={editor.fieldErrors?.providerModelId ? "assistant-editor-model-error" : "assistant-editor-model-help"}
            aria-invalid={Boolean(editor.fieldErrors?.providerModelId) || undefined}
            disabled={locked}
            id="assistant-editor-model"
            value={draft.providerModelId ?? ""}
            onChange={(event) => editor.onChange({
              providerModelId: event.currentTarget.value || null
            })}
          >
            <option value="">Choose a model…</option>
            {options.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label} · {model.providerLabel}
              </option>
            ))}
          </select>
        </span>
        <small id="assistant-editor-model-help">{capabilityLine}</small>
        {editor.fieldErrors?.providerModelId ? (
          <p className="v2-assistant-field-error" id="assistant-editor-model-error" role="alert">
            {editor.fieldErrors.providerModelId}
          </p>
        ) : null}
      </div>

      <div className="v2-assistant-setup-resources">
        <SetupRowV2
          icon="book"
          label="Knowledge"
          open={openResource === "knowledge"}
          summary={joinedSummary(knowledgeLabels)}
          onToggle={() => toggleResource("knowledge")}
        >
          <ChoiceStateV2
            error={options.knowledgeDataState === "error" ? options.knowledgeDataError ?? "Knowledge did not load." : null}
            loading={options.knowledgeDataState === "loading"}
            onRetry={options.onRetryKnowledge}
            resource="Knowledge"
          />
          <fieldset>
            <legend>Bases</legend>
            {options.knowledgeBases.length === 0 && options.knowledgeDataState === "ready" ? <p>No bases available.</p> : null}
            {options.knowledgeBases.map((base) => {
              const checked = selectedKnowledgeBaseIds.includes(base.id);
              return (
                <label key={base.id}>
                  <input
                    checked={checked}
                    disabled={locked || (!checked && (!base.available || selectedKnowledgeCount >= KNOWLEDGE_SELECTION_MAX_EXPLICIT_RESOURCES))}
                    type="checkbox"
                    onChange={(event) => toggleKnowledgeBase(base.id, event.currentTarget.checked)}
                  />
                  <span>{base.name}{base.available ? "" : " · unavailable"}</span>
                </label>
              );
            })}
          </fieldset>
          <fieldset>
            <legend>Documents</legend>
            {options.knowledgeSources.length === 0 && options.knowledgeDataState === "ready" ? <p>No documents available.</p> : null}
            {options.knowledgeSources.map((source) => {
              const checked = selectedKnowledgeSourceIds.includes(source.id);
              return (
                <label key={source.id}>
                  <input
                    checked={checked}
                    disabled={locked || (!checked && (!source.available || selectedKnowledgeCount >= KNOWLEDGE_SELECTION_MAX_EXPLICIT_RESOURCES))}
                    type="checkbox"
                    onChange={(event) => toggleKnowledgeSource(source.id, event.currentTarget.checked)}
                  />
                  <span>{source.name}{source.available ? "" : " · unavailable"}</span>
                </label>
              );
            })}
          </fieldset>
          <small>Select the exact bases and documents this assistant may use.</small>
        </SetupRowV2>

        <SetupRowV2
          icon="plug"
          label="Tools"
          open={openResource === "tools"}
          summary={joinedSummary(selectedMcpLabels)}
          onToggle={() => toggleResource("tools")}
        >
          <fieldset data-invalid={Boolean(editor.fieldErrors?.mcpServerIds) || undefined}>
            <legend>MCP servers</legend>
            {options.mcpServers.length === 0 ? <p>No MCP servers are available.</p> : null}
            {options.mcpServers.map((server) => {
              const selected = draft.mcpServerIds.includes(server.id);
              const startable = server.enabled && isMcpReadinessStartable(server.readiness);
              return (
                <label key={server.id}>
                  <input
                    checked={selected}
                    disabled={locked || (!selected && !startable)}
                    type="checkbox"
                    onChange={(event) => toggleMcpServer(server.id, event.currentTarget.checked)}
                  />
                  <span>
                    {server.name}
                    <small>{server.enabled
                      ? mcpReadinessPresentation(server.readiness).label
                      : "Off in Settings"}</small>
                  </span>
                </label>
              );
            })}
          </fieldset>
          {editor.fieldErrors?.mcpServerIds ? (
            <p className="v2-assistant-field-error" role="alert">{editor.fieldErrors.mcpServerIds}</p>
          ) : null}
          {options.mcpServers.some((server) => !server.enabled) ? (
            <UiV2Button icon="settings" onClick={editor.onOpenMcpSettings}>Enable in Settings › MCP</UiV2Button>
          ) : null}
        </SetupRowV2>

        <SetupRowV2
          icon="globe"
          label="Web search"
          open={openResource === "search"}
          summary={joinedSummary(selectedSearchLabels, "Off")}
          onToggle={() => toggleResource("search")}
        >
          <fieldset>
            <legend>Search sources</legend>
            {options.searchOptions.length === 0 ? <p>No Search sources are available.</p> : null}
            {options.searchOptions.map((option) => {
              const checked = draft.searchOptionIds.includes(option.id);
              return (
                <label key={option.id}>
                  <input
                    checked={checked}
                    disabled={locked || (!checked && draft.searchOptionIds.length >= MAX_SEARCH_PLAN_OPTIONS)}
                    type="checkbox"
                    onChange={(event) => toggleSearchOption(option.id, event.currentTarget.checked)}
                  />
                  <span>{option.label}</span>
                </label>
              );
            })}
          </fieldset>
          {draft.searchOptionIds.length > 1 ? (
            <fieldset>
              <legend>How Search is used</legend>
              <label>
                <input
                  checked={draft.searchPlanMode === "all_selected"}
                  disabled={locked}
                  name="assistant-editor-search-mode"
                  type="radio"
                  onChange={() => editor.onChange({ searchPlanMode: "all_selected" })}
                />
                <span>All selected per search</span>
              </label>
              <label>
                <input
                  checked={draft.searchPlanMode === "model_choice"}
                  disabled={locked}
                  name="assistant-editor-search-mode"
                  type="radio"
                  onChange={() => editor.onChange({ searchPlanMode: "model_choice" })}
                />
                <span>Model chooses</span>
              </label>
            </fieldset>
          ) : null}
        </SetupRowV2>

        <SetupRowV2
          icon="wand"
          label="Skills"
          open={openResource === "skills"}
          summary={joinedSummary(selectedSkillLabels)}
          onToggle={() => toggleResource("skills")}
        >
          <ChoiceStateV2
            error={options.skillDataState === "error" ? options.skillDataError ?? "Skills did not load." : null}
            loading={options.skillDataState === "loading"}
            onRetry={options.onRetrySkills}
            resource="Skills"
          />
          <fieldset>
            <legend>Included Skills</legend>
            {options.skills.length === 0 && options.skillDataState === "ready" ? <p>No Skills are available.</p> : null}
            {options.skills.map((skill) => {
              const checked = draft.skillIds.includes(skill.id);
              const available = !skill.archived;
              return (
                <label key={skill.id}>
                  <input
                    checked={checked}
                    disabled={locked || (!checked && (!available || draft.skillIds.length >= SKILL_MAX_SELECTED))}
                    type="checkbox"
                    onChange={(event) => toggleSkill(skill.id, event.currentTarget.checked)}
                  />
                  <span>
                    {skill.name}{available ? "" : " · unavailable"}
                    <small>{skillScopeLabel(skill)}{checked ? ` · order ${draft.skillIds.indexOf(skill.id) + 1}` : ""}</small>
                  </span>
                </label>
              );
            })}
          </fieldset>
          <small>Skills run in the order selected.</small>
        </SetupRowV2>
      </div>

      <p className="v2-assistant-entitlement-note">
        <UiV2Icon name="lock" />
        <span>Only models and tools you can use yourself are offered here. If your access changes later, the assistant says so before you run it.</span>
      </p>
    </aside>
  );
}
