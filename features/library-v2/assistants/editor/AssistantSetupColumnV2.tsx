"use client";

import { mcpReadinessPresentation } from "@/components/app-shell/mcpReadiness";
import {
  ASSISTANT_SKILL_LIMIT_MESSAGE,
  assistantDraftPolicyErrors,
  controlsDraftIsEmpty,
  type AssistantDraftRows,
  type AssistantEditorView
} from "@/components/assistants/libraryViewContracts";
import { UiV2Button, UiV2Icon, UiV2ProviderMark, type UiV2IconName } from "@/components/ui-v2";
import { assistantAudienceSegment } from "@/features/library-v2/assistants/gallery/assistantDetailCopy";
import {
  ASSISTANT_MAX_MCP_SERVERS,
  ASSISTANT_ROW_KEYS,
  type AssistantRowDeviationKey,
  type AssistantRowKey,
  type AssistantRowPolicy
} from "@/lib/contracts/assistants";
import { SKILL_ASSISTANT_MAX_AVAILABLE, SKILL_MAX_PINNED } from "@/lib/contracts/skills";
import { MAX_SEARCH_PLAN_OPTIONS } from "@/lib/domain/search";
import { useId, useState, type ReactNode } from "react";
import {
  ASSISTANT_INHERIT_LABEL,
  ASSISTANT_INHERIT_MODEL_LABEL,
  ASSISTANT_ROW_LABELS,
  assistantRowDeviationText,
  assistantRowSummary,
  assistantSkillCounts
} from "./assistantEditorSummaries";
import { AssistantParametersV2 } from "./AssistantParametersV2";
import { AssistantSkillsRowV2 } from "./AssistantSkillsRowV2";

export const ASSISTANT_POLICY_TOOLTIP =
  "Fixed: used in every chat, cannot be changed there. Adjustable: the starting value; people can change it in their chat.";

const rowIcons: Readonly<Record<AssistantRowKey, UiV2IconName>> = {
  controls: "sliders",
  model: "layers",
  search: "globe",
  skills: "wand",
  tools: "plug"
};

/** A row asks for a concrete value before Fixed can be saved. */
function needsValueToFix(key: AssistantRowKey, rows: AssistantDraftRows): boolean {
  if (key === "controls") return controlsDraftIsEmpty(rows.controls.value);
  if (key === "skills") return false;
  return rows[key].value.mode === "inherit";
}

/** Live row errors: policy rules and the Skill link limits. */
export function assistantLiveRowErrors(rows: AssistantDraftRows): Partial<Record<AssistantRowKey, string>> {
  const errors = assistantDraftPolicyErrors(rows);
  const counts = assistantSkillCounts(rows);
  if (counts.always > SKILL_MAX_PINNED || counts.onDemand > SKILL_ASSISTANT_MAX_AVAILABLE) {
    errors.skills = ASSISTANT_SKILL_LIMIT_MESSAGE;
  }
  return errors;
}

function PolicyToggle({ describedBy, disabled, onChange, policy }: Readonly<{
  describedBy: string;
  disabled: boolean;
  onChange(policy: AssistantRowPolicy): void;
  policy: AssistantRowPolicy;
}>) {
  const fixed = policy === "fixed";
  const label = fixed ? "Fixed" : "Adjustable";
  // An explicit name: the visible tooltip text must never join it (it is the description).
  return (
    <button
      aria-describedby={describedBy}
      aria-label={label}
      aria-pressed={fixed}
      className="v2-assistant-policy v2-focusable"
      data-policy={policy}
      data-tooltip={ASSISTANT_POLICY_TOOLTIP}
      data-tooltip-side="left"
      disabled={disabled}
      type="button"
      onClick={() => onChange(fixed ? "adjustable" : "fixed")}
    >
      <UiV2Icon name={fixed ? "lock" : "edit"} />
      <span>{label}</span>
    </button>
  );
}

function SetupRow({ children, error, expanded, locked, note, onPolicyChange, onToggle, policyHelpId, row, rows, summary }: Readonly<{
  children: ReactNode;
  error: string | undefined;
  expanded: boolean;
  locked: boolean;
  note: string | null;
  onPolicyChange(policy: AssistantRowPolicy): void;
  onToggle(): void;
  policyHelpId: string;
  row: AssistantRowKey;
  rows: AssistantDraftRows;
  summary: string;
}>) {
  const nameId = `assistant-setup-${row}-name`;
  const valueId = `assistant-setup-${row}-value`;
  const errorId = `assistant-setup-${row}-error`;
  const panelId = `assistant-setup-${row}`;
  return (
    <section
      className="v2-assistant-row"
      data-expanded={expanded || undefined}
      data-invalid={Boolean(error) || undefined}
      data-row={row}
      data-testid={`assistant-setup-row-${row}`}
    >
      <div className="v2-assistant-row-head">
        <button
          aria-controls={panelId}
          aria-describedby={error ? `${valueId} ${errorId}` : valueId}
          aria-expanded={expanded}
          className="v2-assistant-row-toggle v2-focusable"
          type="button"
          onClick={onToggle}
        >
          <UiV2Icon name={rowIcons[row]} />
          <span className="v2-assistant-row-copy">
            <strong id={nameId}>{ASSISTANT_ROW_LABELS[row]}</strong>
            <small aria-hidden="true" id={valueId}>{summary}</small>
          </span>
          <UiV2Icon className="v2-assistant-row-chevron" name="chevron-down" />
        </button>
        <PolicyToggle
          describedBy={policyHelpId}
          disabled={locked}
          policy={rows[row].policy}
          onChange={onPolicyChange}
        />
      </div>
      {error ? <p className="v2-assistant-field-error" id={errorId}>{error}</p> : null}
      {note ? <p className="v2-assistant-setup-deviation">{note}</p> : null}
      <div className="v2-assistant-row-body" hidden={!expanded} id={panelId}>
        {expanded ? children : null}
      </div>
    </section>
  );
}

/** Radio choices of a resource row: Inherit, the explicit empty value, or a selection. */
function ModeChoices<Mode extends string>({ label, name, onChange, options, value }: Readonly<{
  label: string;
  name: string;
  onChange(mode: Mode): void;
  options: readonly { label: string; mode: Mode; sub?: string }[];
  value: Mode;
}>) {
  return (
    <fieldset className="v2-assistant-setup-modes">
      <legend className="v2-sr-only">{label}</legend>
      {options.map((option) => (
        <label key={option.mode}>
          <input checked={value === option.mode} name={name} type="radio" onChange={() => onChange(option.mode)} />
          <span>{option.label}{option.sub ? <small>{option.sub}</small> : null}</span>
        </label>
      ))}
    </fieldset>
  );
}

function ModelBody({ editor }: Readonly<{ editor: AssistantEditorView }>) {
  const value = editor.draft.rows.model.value;
  const models = editor.options.models;
  const selectedId = value.mode === "model" ? value.modelId : null;
  const selected = models.find((model) => model.id === selectedId) ?? null;
  const unknown = value.mode === "model" && !selected;
  const capabilities = selected ? [
    selected.capabilities.reasoning ? "Reasoning" : null,
    selected.capabilities.toolCalling ? "tools" : null,
    selected.capabilities.documentInputMode !== "none" ? "files" : null,
    selected.capabilities.imageInput ? "images" : null
  ].filter((entry): entry is string => Boolean(entry)).join(" · ") || "Text only" : null;
  return (
    <div className="v2-assistant-model">
      <span className="v2-assistant-model-picker">
        {selected ? <UiV2ProviderMark family={selected.providerFamily} label={selected.providerLabel} /> : <UiV2Icon name="layers" />}
        <select
          aria-describedby="assistant-editor-model-help"
          aria-label="Model"
          id="assistant-editor-model"
          value={value.mode === "inherit" ? "" : selectedId ?? "unavailable"}
          onChange={(event) => editor.onRowChange("model", {
            value: event.currentTarget.value ? { mode: "model", modelId: event.currentTarget.value } : { mode: "inherit" }
          })}
        >
          <option value="">{ASSISTANT_INHERIT_MODEL_LABEL}</option>
          {unknown ? <option disabled value={selectedId ?? "unavailable"}>Unavailable model</option> : null}
          {models.map((model) => <option key={model.id} value={model.id}>{model.label} · {model.providerLabel}</option>)}
        </select>
      </span>
      <small id="assistant-editor-model-help">
        {value.mode === "inherit"
          ? "Each person's default model from their Chat defaults."
          : capabilities ?? "This model is not in your catalog. Choose another model or your default."}
      </small>
    </div>
  );
}

function SearchBody({ editor }: Readonly<{ editor: AssistantEditorView }>) {
  const name = useId();
  const value = editor.draft.rows.search.value;
  const options = editor.options.searchOptions;
  const selectedIds = value.mode === "inherit" || value.mode === "off" ? [] : value.optionIds;
  const mode = value.mode === "inherit" ? "inherit" : value.mode === "off" ? "off" : "selected";
  const setIds = (optionIds: string[]) => editor.onRowChange("search", {
    value: { mode: value.mode === "all_selected" ? "all_selected" : "model_choice", optionIds }
  });
  return (
    <>
      <ModeChoices
        label="Web search"
        name={name}
        options={[
          { label: ASSISTANT_INHERIT_LABEL, mode: "inherit" },
          { label: "Off", mode: "off" },
          { label: "Selected sources", mode: "selected", sub: `${selectedIds.length} of ${MAX_SEARCH_PLAN_OPTIONS}` }
        ]}
        value={mode}
        onChange={(next) => editor.onRowChange("search", {
          value: next === "inherit" ? { mode: "inherit" } : next === "off" ? { mode: "off" } : { mode: "model_choice", optionIds: [] }
        })}
      />
      {mode === "selected" ? (
        <fieldset className="v2-assistant-setup-options">
          <legend>Sources</legend>
          {options.length === 0 ? <p>No Search sources are available to you.</p> : null}
          {options.map((option) => {
            const checked = selectedIds.includes(option.id);
            return (
              <label key={option.id}>
                <input
                  checked={checked}
                  disabled={!checked && selectedIds.length >= MAX_SEARCH_PLAN_OPTIONS}
                  type="checkbox"
                  onChange={() => setIds(checked ? selectedIds.filter((id) => id !== option.id) : [...selectedIds, option.id])}
                />
                <span>{option.label}</span>
              </label>
            );
          })}
          {selectedIds.filter((id) => !options.some((option) => option.id === id)).map((id) => (
            <label key={id}>
              <input checked type="checkbox" onChange={() => setIds(selectedIds.filter((selected) => selected !== id))} />
              <span>Unavailable source<small>Remove it to choose another source.</small></span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {mode === "selected" && selectedIds.length > 1 ? (
        <label className="v2-assistant-setup-select">
          When the model searches
          <select
            value={value.mode === "all_selected" ? "all_selected" : "model_choice"}
            onChange={(event) => editor.onRowChange("search", {
              value: { mode: event.currentTarget.value === "all_selected" ? "all_selected" : "model_choice", optionIds: selectedIds }
            })}
          >
            <option value="all_selected">Search all selected sources</option>
            <option value="model_choice">Let the model choose</option>
          </select>
        </label>
      ) : null}
    </>
  );
}

function ToolsBody({ editor }: Readonly<{ editor: AssistantEditorView }>) {
  const name = useId();
  const value = editor.draft.rows.tools.value;
  const servers = editor.options.mcpServers;
  const selectedIds = value.mode === "exact" ? value.serverIds : [];
  const mode = value.mode === "exact" ? "selected" : value.mode;
  const setIds = (serverIds: string[]) => editor.onRowChange("tools", { value: { mode: "exact", serverIds } });
  return (
    <>
      <ModeChoices
        label="Tools"
        name={name}
        options={[
          { label: ASSISTANT_INHERIT_LABEL, mode: "inherit" },
          { label: "Off", mode: "off" },
          { label: "Selected servers", mode: "selected", sub: `${selectedIds.length} of ${ASSISTANT_MAX_MCP_SERVERS}` }
        ]}
        value={mode}
        onChange={(next) => editor.onRowChange("tools", {
          value: next === "inherit" ? { mode: "inherit" } : next === "off" ? { mode: "off" } : { mode: "exact", serverIds: [] }
        })}
      />
      {mode === "selected" ? (
        <fieldset className="v2-assistant-setup-options">
          <legend>Servers</legend>
          {servers.length === 0 ? <p>No MCP servers are set up.</p> : null}
          {servers.map((server) => {
            const checked = selectedIds.includes(server.id);
            // A server that is not ready yet is marked and stays selectable (D-11).
            const status = server.enabled ? mcpReadinessPresentation(server.readiness) : null;
            return (
              <label data-attention={status ? status.kind !== "ready" || undefined : true} key={server.id}>
                <input
                  checked={checked}
                  disabled={!checked && (!server.enabled || selectedIds.length >= ASSISTANT_MAX_MCP_SERVERS)}
                  type="checkbox"
                  onChange={() => setIds(checked ? selectedIds.filter((id) => id !== server.id) : [...selectedIds, server.id])}
                />
                <span>{server.name}<small>{status ? status.label : "Off in MCP servers"}</small></span>
              </label>
            );
          })}
          <small>Selected servers load all their tools.</small>
        </fieldset>
      ) : null}
      {mode === "selected" && (servers.length === 0 || servers.some((server) => !server.enabled)) ? (
        <UiV2Button icon="settings" onClick={editor.onOpenMcpSettings}>Open MCP servers</UiV2Button>
      ) : null}
    </>
  );
}

/**
 * The Setup column: five rows, each a value and a Fixed or Adjustable policy,
 * then the Sharing card. Errors stay at their rows.
 */
export function AssistantSetupColumnV2({ editor, locked, onOpenSharing }: Readonly<{
  editor: AssistantEditorView;
  locked: boolean;
  onOpenSharing(): void;
}>) {
  const rows = editor.draft.rows;
  const failedRows = (errors: AssistantEditorView["errors"]) => ASSISTANT_ROW_KEYS.filter((row) => errors?.rows[row]);
  const [expanded, setExpanded] = useState<ReadonlySet<AssistantRowKey>>(() => new Set([
    ...(editor.initialExpandedRow ? [editor.initialExpandedRow] : []),
    ...failedRows(editor.errors)
  ]));
  const policyHelpId = useId();
  const saveFirstId = useId();
  const liveErrors = assistantLiveRowErrors(rows);
  // A failed save opens the rows it names, so field errors inside them show.
  const [seenErrors, setSeenErrors] = useState(editor.errors);
  if (seenErrors !== editor.errors) {
    setSeenErrors(editor.errors);
    const failed = failedRows(editor.errors);
    if (failed.length > 0) setExpanded((current) => new Set([...current, ...failed]));
  }
  const toggle = (row: AssistantRowKey, open?: boolean) => setExpanded((current) => {
    const next = new Set(current);
    if (open ?? !next.has(row)) next.add(row);
    else next.delete(row);
    return next;
  });
  const bodies: Record<AssistantRowKey, ReactNode> = {
    controls: <AssistantParametersV2 editor={editor} />,
    model: <ModelBody editor={editor} />,
    search: <SearchBody editor={editor} />,
    skills: <AssistantSkillsRowV2 editor={editor} locked={locked} />,
    tools: <ToolsBody editor={editor} />
  };
  const deviation = (row: AssistantRowKey) => {
    const entry = row in editor.rowAvailability
      ? editor.rowAvailability[row as AssistantRowDeviationKey]
      : undefined;
    return entry && rows[row].policy === "adjustable" ? assistantRowDeviationText(entry) : null;
  };

  return (
    <aside aria-labelledby="assistant-setup-heading" className="v2-assistant-setup-column">
      <header>
        <h3 id="assistant-setup-heading">Setup</h3>
        <p>What a chat starts with. Fixed rows cannot be changed in a chat; Adjustable rows can.</p>
        <p className="v2-sr-only" id={policyHelpId}>{ASSISTANT_POLICY_TOOLTIP}</p>
      </header>
      <fieldset className="v2-assistant-rows" disabled={locked}>
        <legend className="v2-sr-only">Setup rows</legend>
        {ASSISTANT_ROW_KEYS.map((row) => (
          <SetupRow
            error={editor.errors?.rows[row] ?? liveErrors[row]}
            expanded={expanded.has(row)}
            key={row}
            locked={locked}
            note={deviation(row)}
            policyHelpId={policyHelpId}
            row={row}
            rows={rows}
            summary={assistantRowSummary(row, rows, editor.options)}
            onPolicyChange={(policy) => {
              editor.onRowChange(row, { policy });
              // Fixed needs a concrete value: open the row to ask for it.
              if (policy === "fixed" && needsValueToFix(row, rows)) toggle(row, true);
            }}
            onToggle={() => toggle(row)}
          >
            {bodies[row]}
          </SetupRow>
        ))}
      </fieldset>
      <section aria-labelledby="assistant-sharing-heading" className="v2-assistant-sharing-card">
        <UiV2Icon name="share" />
        <span>
          <strong id="assistant-sharing-heading">Sharing</strong>
          <small>{assistantAudienceSegment(editor.scope, editor.audience)}</small>
        </span>
        <UiV2Button
          aria-describedby={editor.onOpenSharing ? undefined : saveFirstId}
          disabled={!editor.onOpenSharing || locked}
          onClick={onOpenSharing}
        >
          Manage sharing…
        </UiV2Button>
        {editor.onOpenSharing ? null : <small className="v2-assistant-sharing-hint" id={saveFirstId}>Save first</small>}
      </section>
    </aside>
  );
}
