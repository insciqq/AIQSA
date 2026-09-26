"use client";

import type { AdminModelPolicyUpdateInput } from "@/components/admin/adminModelPolicyApi";
import { cardClass, compactInputClass, compactSelectClass, sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import { UiV2Button, UiV2Switch } from "@/components/ui-v2";
import type { AdminGroup } from "@/lib/contracts/admin";
import type { AdminDefaultAnswerModelCandidate, AdminModelPolicyCatalog } from "@/lib/contracts/adminModelPolicy";
import { MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS, MCP_AUTO_DISCOVERY_OUTPUT_TOKEN_LIMITS, isMcpAutoDiscoveryOutputTokens, MCP_RUN_PLAN_LIMITS } from "@/lib/contracts/mcp";
import { resolveProviderConnectionLabels } from "@/lib/contracts/providerConnectionLabels";
import type { ToolObservationPolicy } from "@/lib/contracts/toolObservationPolicy";
import { useId, useMemo, useState } from "react";

type Draft = Readonly<{
  calls: string;
  effort: string;
  mcpTools: string;
  /** Empty while the saved policy is unknown. */
  observation: ToolObservationPolicy | "";
  outputTokens: string;
  outputMode: "model" | "manual";
  modelId: string;
  rounds: string;
  timeout: string;
}>;

const emptyDraft: Draft = {
  calls: "", effort: "", mcpTools: "", observation: "", outputTokens: "", outputMode: "model", modelId: "", rounds: "", timeout: ""
};

const OBSERVATION_POLICY_LABEL = "Tool result store and context compaction";

function draftFor(catalog: AdminModelPolicyCatalog | null): Draft {
  if (!catalog) return emptyDraft;
  return {
    calls: String(catalog.policy.maxToolCalls),
    effort: catalog.policy.reasoningEffort ?? "",
    mcpTools: String(catalog.policy.maxMcpToolsPerDiscovery),
    observation: catalog.policy.toolObservationPolicy ?? "",
    outputTokens: String(catalog.policy.mcpAutoDiscoveryMaxOutputTokens ?? MCP_AUTO_DISCOVERY_OUTPUT_TOKEN_LIMITS.fallbackTokens),
    outputMode: catalog.policy.mcpAutoDiscoveryMaxOutputTokens === null ? "model" : "manual",
    modelId: catalog.policy.defaultModel?.id ?? "",
    rounds: String(catalog.policy.maxToolRounds),
    timeout: catalog.policy.mcpAutoDiscoveryTimeoutSeconds === null ? "" : String(catalog.policy.mcpAutoDiscoveryTimeoutSeconds)
  };
}

function positiveSafeInteger(value: string): number | null {
  if (!/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Candidates at least one active group can reach through a model grant. */
export function reachableDefaultCandidates(
  catalog: AdminModelPolicyCatalog,
  groups: readonly AdminGroup[]
): AdminDefaultAnswerModelCandidate[] {
  if (groups.some((group) => !group.archivedAt && group.systemRole === "full_access")) {
    return [...catalog.candidates];
  }
  const grants = groups
    .filter((group) => !group.archivedAt)
    .flatMap((group) => group.accessGrants)
    .filter((grant) => grant.enabled && grant.provider !== null && grant.searchStrategy === null);
  return catalog.candidates.filter((candidate) => grants.some((grant) =>
    grant.provider === candidate.connectionId && (grant.modelId === null || grant.modelId === candidate.id)));
}

export const NO_REACHABLE_DEFAULT_COPY =
  "No enabled chat model is reachable by any group yet. Give a group access to a model first.";

/**
 * Chat defaults (PRD 5.5): the installation default model with its reasoning
 * effort, the per-answer tool limits and the observation/compaction switch,
 * saved together with one `Save` under the policy version.
 */
export function AdminChatDefaultsCard({
  busy,
  catalog,
  error,
  groups,
  loading,
  onSave
}: Readonly<{
  busy: boolean;
  catalog: AdminModelPolicyCatalog | null;
  error: string | null;
  groups: readonly AdminGroup[];
  loading: boolean;
  onSave(input: Omit<AdminModelPolicyUpdateInput, "expectedVersion">): Promise<string | null>;
}>) {
  const [edits, setEdits] = useState<Partial<Draft>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const observationHelpId = useId();
  const saveBlockedId = useId();
  const current = draftFor(catalog);
  const draft = { ...current, ...edits };
  const reachable = useMemo(
    () => (catalog ? reachableDefaultCandidates(catalog, groups) : []),
    [catalog, groups]
  );
  const labels = useMemo(() => resolveProviderConnectionLabels([
    ...(catalog?.candidates ?? []),
    ...(catalog?.policy.defaultModel ? [catalog.policy.defaultModel] : [])
  ].map((item) => ({ id: item.connectionId, name: item.connectionDisplayName }))), [catalog]);
  const label = (item: AdminDefaultAnswerModelCandidate) =>
    `${labels.get(item.connectionId) ?? item.connectionDisplayName} / ${item.displayName}`;
  const selectedModel = reachable.find((item) => item.id === draft.modelId) ??
    (catalog?.policy.defaultModel?.id === draft.modelId ? catalog.policy.defaultModel : null);
  const efforts = selectedModel?.reasoningEfforts ?? [];
  const effortValid = draft.effort === "" || efforts.includes(draft.effort);
  const parsed = {
    calls: positiveSafeInteger(draft.calls),
    mcpTools: positiveSafeInteger(draft.mcpTools),
    outputTokens: positiveSafeInteger(draft.outputTokens),
    rounds: positiveSafeInteger(draft.rounds),
    timeout: positiveSafeInteger(draft.timeout)
  };
  const invalidLimits = [
    ...(parsed.rounds === null ? ["Rounds"] : []),
    ...(parsed.calls === null ? ["Calls"] : []),
    ...(parsed.mcpTools === null || parsed.mcpTools > MCP_RUN_PLAN_LIMITS.maxTools ? ["MCP Auto tools"] : []),
    ...(draft.outputMode === "manual" && !isMcpAutoDiscoveryOutputTokens(parsed.outputTokens) ? ["MCP Auto output tokens"] : []),
    ...(draft.timeout !== "" && (parsed.timeout === null || parsed.timeout < MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.minSeconds ||
      parsed.timeout > MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.maxSeconds) ? ["Discovery timeout"] : [])
  ];
  const limitsValid = invalidLimits.length === 0;
  const modelChanged = draft.modelId !== current.modelId || draft.effort !== current.effort;
  const limitsChanged = (["calls", "mcpTools", "outputMode", "outputTokens", "rounds", "timeout"] as const)
    .filter((key) => draft[key] !== current[key]).length;
  const observationChanged = draft.observation !== "" && draft.observation !== current.observation;
  const changed = (modelChanged ? 1 : 0) + limitsChanged + (observationChanged ? 1 : 0);
  // Each field group is validated only when it is part of the request, so a
  // saved value the client can no longer confirm never blocks another group.
  const saveBlockedReason = modelChanged && !effortValid
    ? "Choose an available reasoning option to save."
    : limitsChanged > 0 && !limitsValid
      ? `Enter a valid ${new Intl.ListFormat("en", { type: "conjunction" }).format(invalidLimits)} to save.`
      : null;
  const canSave = Boolean(catalog) && changed > 0 && saveBlockedReason === null && !busy;
  const shownBlockedReason = catalog && !error && changed > 0 ? saveBlockedReason : null;
  const currentUnreachable = Boolean(catalog?.policy.defaultModel) &&
    !reachable.some((item) => item.id === catalog?.policy.defaultModel?.id);

  const save = async () => {
    if (!catalog || !canSave) return;
    setFormError(null);
    const message = await onSave({
      ...(modelChanged ? {
        providerModelId: draft.modelId || null,
        reasoningEffort: draft.modelId ? draft.effort || null : null
      } : {}),
      ...(limitsChanged > 0 ? {
        maxMcpToolsPerDiscovery: parsed.mcpTools!,
        maxToolCalls: parsed.calls!,
        maxToolRounds: parsed.rounds!,
        mcpAutoDiscoveryTimeoutSeconds: draft.timeout === "" ? null : parsed.timeout!,
        mcpAutoDiscoveryMaxOutputTokens: draft.outputMode === "model" ? null : parsed.outputTokens!
      } : {}),
      ...(observationChanged && draft.observation !== "" ? { toolObservationPolicy: draft.observation } : {})
    });
    if (message) setFormError(message);
    else setEdits({});
  };

  const limitField = (
    key: "calls" | "mcpTools" | "outputTokens" | "rounds" | "timeout",
    name: string,
    options: Readonly<{ max?: number; min?: number; suffix?: string; width: string }>
  ) => (
    <label className="flex items-center gap-2 text-xs text-ink-muted">
      <span>{name}</span>
      <input
        aria-invalid={draft[key] !== "" && (
          key === "calls" || key === "rounds"
            ? parsed[key] === null
            : key === "outputTokens"
              ? !isMcpAutoDiscoveryOutputTokens(parsed.outputTokens)
            : key === "mcpTools"
              ? parsed.mcpTools === null || parsed.mcpTools > MCP_RUN_PLAN_LIMITS.maxTools
              : parsed.timeout === null || parsed.timeout < MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.minSeconds ||
                parsed.timeout > MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.maxSeconds
        ) ? true : undefined}
        aria-label={name}
        className={`${compactInputClass} ${options.width}`}
        disabled={!catalog || busy}
        inputMode="numeric"
        max={options.max}
        min={options.min ?? 1}
        onChange={(event) => {
          const value = event.currentTarget.value;
          setEdits((previous) => ({ ...previous, [key]: value }));
        }}
        step={1}
        placeholder={key === "timeout" ? "Auto" : undefined}
        type="number"
        value={draft[key]}
      />
      {options.suffix ? <span aria-hidden="true">{options.suffix}</span> : null}
    </label>
  );

  return (
    <section aria-labelledby="admin-chat-defaults-heading" className="grid gap-2.5" data-testid="admin-chat-defaults">
      <h2 className={sectionHeadingClass} id="admin-chat-defaults-heading">Chat defaults</h2>
      <div className={cardClass}>
        <div className="grid gap-3 px-5 py-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">Default chat model</p>
            <p className="mt-0.5 text-xs leading-5 text-ink-muted">
              New chats start here when a person has no personal default and has access to it
            </p>
          </div>
          <div className="flex min-w-0 flex-wrap gap-2 xl:justify-end">
            <select
              aria-label="Default chat model"
              className={`${compactSelectClass} xl:w-[19rem]`}
              disabled={!catalog || busy}
              onChange={(event) => {
                const modelId = event.currentTarget.value;
                setEdits((previous) => ({ ...previous, effort: "", modelId }));
              }}
              value={draft.modelId}
            >
              <option value="">No default</option>
              {catalog?.policy.defaultModel && currentUnreachable ? (
                <option disabled value={catalog.policy.defaultModel.id}>
                  Unavailable — {label(catalog.policy.defaultModel)}
                </option>
              ) : null}
              {reachable.map((item) => (
                <option key={item.id} value={item.id}>{label(item)}</option>
              ))}
            </select>
          </div>
          {catalog && reachable.length === 0 ? (
            <p className="text-xs leading-5 text-caution xl:col-span-2" role="status">{NO_REACHABLE_DEFAULT_COPY}</p>
          ) : null}
        </div>
        <details className="border-t border-trace-subtle">
          <summary className="cursor-pointer px-5 py-3 text-sm font-medium text-ink-secondary outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus">
            Reasoning
          </summary>
          <div className="px-5 pb-4">
            <select
              aria-label="Reasoning"
              className={`${compactSelectClass} xl:w-[11rem]`}
              disabled={!catalog || busy || !draft.modelId || (efforts.length === 0 && !draft.effort)}
              onChange={(event) => {
                const effort = event.currentTarget.value;
                setEdits((previous) => ({ ...previous, effort }));
              }}
              value={draft.effort}
            >
              <option value="">
                Reasoning: provider default{selectedModel?.defaultReasoningEffort ? ` (${selectedModel.defaultReasoningEffort})` : ""}
              </option>
              {!effortValid ? <option disabled value={draft.effort}>Reasoning: {draft.effort} (unavailable)</option> : null}
              {efforts.map((effort) => <option key={effort} value={effort}>Reasoning: {effort}</option>)}
            </select>
          </div>
        </details>
          <div className="grid gap-3 border-t border-trace-subtle px-5 py-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">Tool limits per answer</p>
              <p className="mt-0.5 text-xs leading-5 text-ink-muted">Apply to new answers only</p>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {limitField("rounds", "Rounds", { width: "w-16" })}
              {limitField("calls", "Calls", { width: "w-16" })}
              {limitField("mcpTools", "MCP Auto tools", { max: MCP_RUN_PLAN_LIMITS.maxTools, width: "w-16" })}
              <label className="flex items-center gap-2 text-xs text-ink-muted">
                <span>MCP output budget</span>
                <select aria-label="MCP output budget" className={compactSelectClass}
                  disabled={!catalog || busy} value={draft.outputMode}
                  onChange={(event) => {
                    const outputMode = event.currentTarget.value === "model" ? "model" : "manual";
                    setEdits((previous) => ({ ...previous, outputMode }));
                  }}>
                  <option value="model">Auto · System Model</option>
                  <option value="manual">Custom limit</option>
                </select>
              </label>
              {draft.outputMode === "manual" ? limitField("outputTokens", "MCP Auto output tokens", {
                max: MCP_AUTO_DISCOVERY_OUTPUT_TOKEN_LIMITS.maxTokens,
                min: MCP_AUTO_DISCOVERY_OUTPUT_TOKEN_LIMITS.minTokens,
                width: "w-24"
              }) : null}
              {limitField("timeout", "Discovery timeout", {
                max: MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.maxSeconds,
                min: MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.minSeconds,
                suffix: "s",
                width: "w-20"
              })}
            </div>
            <p className="text-xs leading-5 text-ink-muted">
              Auto uses the System Model’s output setting and available context for hidden reasoning and JSON tool selection.
              Without an output setting or a known model limit, Auto allows up to 65,536 tokens. Larger allowances can increase time and cost.
              Leave discovery timeout blank to use the System Model’s response timeout. Tool calls use their MCP server’s timeout.
            </p>
          </div>
        <div className="flex min-w-0 items-center justify-between gap-6 border-t border-trace-subtle px-5 py-4">
          <span className="min-w-0">
            <span className="block text-sm font-medium text-ink">{OBSERVATION_POLICY_LABEL}</span>
            <span className="mt-0.5 block text-xs leading-5 text-ink-muted" id={observationHelpId}>
              {draft.observation === ""
                ? !catalog && !error ? "Loading the saved setting…" : "The saved setting is unavailable. Reload to change it."
                : "On by default. Keeps full tool results readable on request and compacts long chats with summaries from the answer model. Off is a kill switch: new answers use the previous trimming. Answers already started keep their mode."}
            </span>
          </span>
          <UiV2Switch
            aria-describedby={observationHelpId}
            checked={draft.observation === "v1"}
            className="shrink-0"
            disabled={!catalog || busy || draft.observation === ""}
            label={OBSERVATION_POLICY_LABEL}
            onChange={(enabled) => setEdits((previous) => ({ ...previous, observation: enabled ? "v1" : "off" }))}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-b-[12px] border-t border-trace-subtle bg-workspace-rail/40 px-5 py-3">
          <p className="mr-auto min-w-0 text-xs text-ink-muted" role="status">
            {error ?? (loading && !catalog
              ? "Loading chat defaults…"
              : formError ?? (changed > 0
                ? `${changed} unsaved ${changed === 1 ? "change" : "changes"}`
                : "No unsaved changes"))}
            {shownBlockedReason ? (
              <span className="block text-caution" id={saveBlockedId}>{shownBlockedReason}</span>
            ) : null}
          </p>
          {formError ? <span className="sr-only" role="alert">{formError}</span> : null}
          <UiV2Button
            disabled={changed === 0 || busy}
            onClick={() => {
              setEdits({});
              setFormError(null);
            }}
            tone="ghost"
          >
            Discard
          </UiV2Button>
          <UiV2Button
            aria-describedby={shownBlockedReason ? saveBlockedId : undefined}
            busy={busy && changed > 0}
            disabled={!canSave}
            onClick={() => void save()}
            tone="primary"
          >
            Save
          </UiV2Button>
        </div>
      </div>
    </section>
  );
}
