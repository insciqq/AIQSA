"use client";

import type { AdminModelPolicyUpdateInput } from "@/components/admin/adminModelPolicyApi";
import { cardClass, compactInputClass, compactSelectClass, sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import { UiV2Button } from "@/components/ui-v2";
import type { AdminGroup } from "@/lib/contracts/admin";
import type { AdminDefaultAnswerModelCandidate, AdminModelPolicyCatalog } from "@/lib/contracts/adminModelPolicy";
import { MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS, MCP_RUN_PLAN_LIMITS } from "@/lib/contracts/mcp";
import { resolveProviderConnectionLabels } from "@/lib/contracts/providerConnectionLabels";
import { useMemo, useState } from "react";

type Draft = Readonly<{
  calls: string;
  effort: string;
  mcpTools: string;
  modelId: string;
  rounds: string;
  timeout: string;
}>;

const emptyDraft: Draft = { calls: "", effort: "", mcpTools: "", modelId: "", rounds: "", timeout: "" };

function draftFor(catalog: AdminModelPolicyCatalog | null): Draft {
  if (!catalog) return emptyDraft;
  return {
    calls: String(catalog.policy.maxToolCalls),
    effort: catalog.policy.reasoningEffort ?? "",
    mcpTools: String(catalog.policy.maxMcpToolsPerDiscovery),
    modelId: catalog.policy.defaultModel?.id ?? "",
    rounds: String(catalog.policy.maxToolRounds),
    timeout: String(catalog.policy.mcpAutoDiscoveryTimeoutSeconds)
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
 * effort and the per-answer tool limits, saved together with one `Save`.
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
    rounds: positiveSafeInteger(draft.rounds),
    timeout: positiveSafeInteger(draft.timeout)
  };
  const limitsValid = parsed.calls !== null && parsed.rounds !== null &&
    parsed.mcpTools !== null && parsed.mcpTools <= MCP_RUN_PLAN_LIMITS.maxTools &&
    parsed.timeout !== null && parsed.timeout >= MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.minSeconds &&
    parsed.timeout <= MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.maxSeconds;
  const modelChanged = draft.modelId !== current.modelId || draft.effort !== current.effort;
  const limitsChanged = (["calls", "mcpTools", "rounds", "timeout"] as const)
    .filter((key) => draft[key] !== current[key]).length;
  const changed = (modelChanged ? 1 : 0) + limitsChanged;
  const canSave = Boolean(catalog) && changed > 0 && effortValid && limitsValid && !busy;
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
        mcpAutoDiscoveryTimeoutSeconds: parsed.timeout!
      } : {})
    });
    if (message) setFormError(message);
    else setEdits({});
  };

  const limitField = (
    key: "calls" | "mcpTools" | "rounds" | "timeout",
    name: string,
    options: Readonly<{ max?: number; min?: number; suffix?: string; width: string }>
  ) => (
    <label className="flex items-center gap-2 text-xs text-ink-muted">
      <span>{name}</span>
      <input
        aria-invalid={draft[key] !== "" && (
          key === "calls" || key === "rounds"
            ? parsed[key] === null
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
            Advanced <span className="ml-2 text-xs font-normal text-ink-muted">Reasoning and tool limits</span>
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
          <div className="grid gap-3 border-t border-trace-subtle px-5 py-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">Tool limits per answer</p>
              <p className="mt-0.5 text-xs leading-5 text-ink-muted">Apply to new answers only</p>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {limitField("rounds", "Rounds", { width: "w-16" })}
              {limitField("calls", "Calls", { width: "w-16" })}
              {limitField("mcpTools", "MCP Auto tools", { max: MCP_RUN_PLAN_LIMITS.maxTools, width: "w-16" })}
              {limitField("timeout", "Auto timeout", {
                max: MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.maxSeconds,
                min: MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.minSeconds,
                suffix: "s",
                width: "w-[4.5rem]"
              })}
            </div>
          </div>
        </details>
        <div className="flex flex-wrap items-center gap-2 rounded-b-[12px] border-t border-trace-subtle bg-workspace-rail/40 px-5 py-3">
          <p className="mr-auto min-w-0 text-xs text-ink-muted" role="status">
            {error ?? (loading && !catalog
              ? "Loading chat defaults…"
              : formError ?? (changed > 0
                ? `${changed} unsaved ${changed === 1 ? "change" : "changes"}`
                : "No unsaved changes"))}
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
          <UiV2Button busy={busy && changed > 0} disabled={!canSave} onClick={() => void save()} tone="primary">
            Save
          </UiV2Button>
        </div>
      </div>
    </section>
  );
}
