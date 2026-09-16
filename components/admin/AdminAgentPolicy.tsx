"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AGENT_POLICY_LIMITS, decodeAgentPolicy, type AgentPolicyWire } from "@/lib/contracts/agentPolicy";
import { UiV2Button, UiV2Switch } from "@/components/ui-v2";
import { cardClass, compactInputClass, sectionHeadingClass } from "./roles/rolesControls";
import type { AdminFeedbackController } from "./useAdminFeedback";
import { requestAgentPolicy, agentPolicyErrorMessage } from "./adminAgentPolicyApi";

const fields = [
  ["timeoutSeconds", "Time per turn (minutes)"],
  ["maxModelCalls", "Provider calls per turn"],
  ["maxToolCalls", "MCP calls per turn"],
  ["tokenBudget", "Token budget per turn"],
  ["maxOutputTokens", "Output tokens per generation"]
] as const;
type Field = typeof fields[number][0];
type Draft = Record<Field, string> & { limitsEnabled: boolean };
const draftOf = (policy: AgentPolicyWire): Draft => ({ limitsEnabled: policy.limitsEnabled,
  timeoutSeconds: String(policy.timeoutSeconds / 60), maxModelCalls: String(policy.maxModelCalls),
  maxToolCalls: String(policy.maxToolCalls), tokenBudget: String(policy.tokenBudget), maxOutputTokens: String(policy.maxOutputTokens) });

export function AdminAgentPolicy({ reportNotice }: Readonly<{ reportNotice: AdminFeedbackController["reportNotice"] }>) {
  const [policy, setPolicy] = useState<AgentPolicyWire | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const alive = useRef(false);
  const dirty = useRef(false);
  const pending = useRef<AbortController | null>(null);
  const refresh = useCallback(async (preserveDraft = false) => {
    if (pending.current || !alive.current || dirty.current && !preserveDraft) return;
    const controller = new AbortController();
    pending.current = controller;
    const result = await requestAgentPolicy({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
    if (!alive.current || controller.signal.aborted) return;
    pending.current = null;
    setLoading(false);
    if (result.ok) {
      setPolicy(result.policy);
      if (!dirty.current) setDraft(draftOf(result.policy));
      if (!preserveDraft) setError(null);
    } else {
      setError(agentPolicyErrorMessage(result.error));
      if (["forbidden", "unauthorized"].includes(result.error)) setPolicy(null);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    const onFocus = () => { if (document.visibilityState !== "hidden") void refresh(); };
    queueMicrotask(() => { void refresh(); });
    window.addEventListener("focus", onFocus);
    return () => { alive.current = false; pending.current?.abort(); pending.current = null; window.removeEventListener("focus", onFocus); };
  }, [refresh]);
  const candidate = policy && draft ? decodeAgentPolicy({ version: policy.version, limitsEnabled: draft.limitsEnabled,
    ...Object.fromEntries(fields.map(([key]) => [key, key === "timeoutSeconds"
      ? /^\d+(?:\.\d+)?$/u.test(draft[key]) ? Math.round(Number(draft[key]) * 60) : NaN
      : /^\d+$/u.test(draft[key]) ? Number(draft[key]) : NaN])) }) : null;
  const changed = policy && draft && JSON.stringify(draftOf(policy)) !== JSON.stringify(draft);
  async function save() {
    if (!candidate || pending.current || busy) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    const { version, ...values } = candidate;
    const result = await requestAgentPolicy({ update: { ...values, expectedVersion: version },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
    if (!alive.current || controller.signal.aborted) return;
    pending.current = null;
    setBusy(false);
    if (result.ok) {
      dirty.current = false;
      setPolicy(result.policy); setDraft(draftOf(result.policy)); setError(null); setConflict(false);
      reportNotice("Agent settings saved. They apply to new turns.");
    } else {
      setError(agentPolicyErrorMessage(result.error));
      if (result.error === "agent_policy_stale") { setConflict(true); await refresh(true); }
      if (["forbidden", "unauthorized"].includes(result.error)) setPolicy(null);
    }
  }
  return <section aria-label="Agent settings" className={`${cardClass} p-5`}>
    <h2 className={sectionHeadingClass}>Agent</h2>
    <p className="mt-2 text-xs leading-5 text-ink-muted">Settings apply to new Agent turns across the installation. Usage and cost are recorded even when limits are off.</p>
    {error ? <p className="mt-3 text-xs leading-5 text-critical" role="alert">{error}</p> : null}
    {policy && draft ? <>
      <div className="flex items-center justify-between gap-6 py-4">
        <span className="text-sm font-medium text-ink">Apply Agent limits</span>
        <UiV2Switch checked={draft.limitsEnabled} disabled={busy} label="Apply Agent limits" onChange={(value) => {
          dirty.current = true; setDraft({ ...draft, limitsEnabled: value });
        }} />
      </div>
      {conflict ? <p className="mb-3 text-xs text-ink-muted">Saved limits: {policy.limitsEnabled ? "On" : "Off"}. Saved values are shown below each field.</p> : null}
      <div className="grid gap-4 border-t border-trace-subtle pt-4 sm:grid-cols-2">
        {fields.map(([key, label]) => <label key={key} className="flex min-w-0 flex-col gap-1.5 text-xs text-ink-secondary">
          {label}
          <input className={`${compactInputClass} w-full min-w-0 py-2`}
            type="number" min={AGENT_POLICY_LIMITS[key].min / (key === "timeoutSeconds" ? 60 : 1)}
            max={AGENT_POLICY_LIMITS[key].max / (key === "timeoutSeconds" ? 60 : 1)} step={key === "timeoutSeconds" ? "any" : 1}
            disabled={busy || !draft.limitsEnabled} value={draft[key]}
            onChange={(event) => { dirty.current = true; setDraft({ ...draft, [key]: event.target.value }); }} />
          {conflict ? <span className="text-ink-muted">Saved: {key === "timeoutSeconds" ? policy[key] / 60 : policy[key]}</span> : null}
        </label>)}
      </div>
      {draft.limitsEnabled && !candidate ? <p className="mt-3 text-xs text-critical" role="alert">Enter valid values within each field’s range. Call and token counts must be whole numbers.</p> : null}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <UiV2Button disabled={!candidate || !changed || busy} onClick={() => { void save(); }}>{busy ? "Saving…" : "Save Agent settings"}</UiV2Button>
        {changed ? <UiV2Button tone="ghost" disabled={busy} onClick={() => {
          dirty.current = false; setDraft(draftOf(policy)); setConflict(false); setError(null); void refresh();
        }}>Use saved values</UiV2Button> : null}
      </div>
    </> : loading ? <p className="mt-3 text-sm text-ink-muted" role="status">Loading Agent settings…</p>
      : <UiV2Button tone="ghost" onClick={() => { dirty.current = false; void refresh(); }}>Try again</UiV2Button>}
  </section>;
}
