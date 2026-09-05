"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  adminSystemModelPolicyErrorMessage, getAdminSystemModelPolicy,
  updateAdminSystemModelPolicy, verifyAdminSystemModelRole
} from "./adminSystemModelPolicyApi";
import { AdminKnowledgeModelAssignments } from "./AdminKnowledgeModelAssignments";
import { useAdminDraftProtection } from "./AdminDraftProtection";
import { inputClass, primaryButton, quietButton } from "./adminPrimitives";
import type {
  AdminSystemModelCandidate, AdminSystemModelPolicyCatalog, SystemModelVerificationRole
} from "@/lib/contracts/adminSystemModelPolicy";
import { resolveProviderConnectionLabels } from "@/lib/contracts/providerConnectionLabels";

type Draft = { memory: string; effort: string; reranker: string; pdf: string; pdfEffort: string; allowPdf: boolean };
type Assignment = "memory" | "reranker" | "pdf";
const emptyDraft: Draft = { memory: "", effort: "", reranker: "", pdf: "", pdfEffort: "", allowPdf: false };
function draftFor(catalog: AdminSystemModelPolicyCatalog): Draft {
  return { memory: catalog.policy.systemModel?.id ?? "", effort: catalog.policy.reasoningEffort ?? "",
    reranker: catalog.policy.rerankerModel?.id ?? "", pdf: catalog.policy.chatPdfModel?.id ?? "",
    pdfEffort: catalog.policy.chatPdfReasoningEffort ?? "", allowPdf: catalog.policy.chatPdfPreparationAllowed };
}
function verificationLabel(value: string | undefined) {
  return value === "verified" ? "verified" : value === "unsupported" ? "unsupported" : "verification required";
}

export function AdminProviderSystemModelTask({ active, onMutationCommitted }: Readonly<{
  active: boolean;
  onMutationCommitted?(): void | Promise<unknown>;
}>) {
  const [catalog, setCatalog] = useState<AdminSystemModelPolicyCatalog | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verifyRole, setVerifyRole] = useState<SystemModelVerificationRole>("memory");
  const [verifyModel, setVerifyModel] = useState("");
  const current = catalog ? draftFor(catalog) : emptyDraft;
  const dirty = Boolean(catalog && Object.keys(draft).some((key) =>
    draft[key as keyof Draft] !== current[key as keyof Draft]));
  const discard = useAdminDraftProtection({ dirty, pending: dirty && busy, owner: "system-model-assignments",
    onDiscard: () => setDraft(current) });
  const labels = useMemo(() => resolveProviderConnectionLabels([
    ...(catalog?.verificationCandidates ?? []), ...(catalog?.rerankerCandidates ?? []),
    ...(catalog?.policy.systemModel ? [catalog.policy.systemModel] : []),
    ...(catalog?.policy.chatPdfModel ? [catalog.policy.chatPdfModel] : []),
    ...(catalog?.policy.rerankerModel ? [catalog.policy.rerankerModel] : [])
  ].map((item) => ({ id: item.connectionId, name: item.connectionDisplayName }))), [catalog]);
  const label = (item: { connectionId: string; connectionDisplayName: string; displayName: string }) =>
    (labels.get(item.connectionId) ?? item.connectionDisplayName) + " / " + item.displayName;
  const refresh = useCallback(async () => {
    setBusy(true); setError(null);
    const result = await getAdminSystemModelPolicy();
    setBusy(false);
    if (!result.ok) { setError(adminSystemModelPolicyErrorMessage(result.error)); return; }
    setCatalog(result.data); setDraft(draftFor(result.data));
  }, []);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    queueMicrotask(() => { if (!disposed) void refresh(); });
    return () => { disposed = true; };
  }, [active, refresh]);
  const save = async (assignment: Assignment) => {
    if (!catalog || busy) return;
    setBusy(true); setError(null); setNotice(null);
    const result = await updateAdminSystemModelPolicy({
      expectedVersion: catalog.policy.version,
      ...(assignment === "memory" ? { providerModelId: draft.memory || null, reasoningEffort: draft.memory ? draft.effort || null : null } : {}),
      ...(assignment === "reranker" ? { rerankerProviderModelId: draft.reranker || null } : {}),
      ...(assignment === "pdf" ? { chatPdfProviderModelId: draft.pdf || null,
        chatPdfReasoningEffort: draft.pdf ? draft.pdfEffort || null : null, chatPdfPreparationAllowed: draft.allowPdf } : {})
    });
    setBusy(false);
    if (!result.ok) { setError(adminSystemModelPolicyErrorMessage(result.error)); return; }
    setCatalog(result.data);
    const saved = draftFor(result.data);
    setDraft((previous) => ({ ...previous,
      ...(assignment === "memory" ? { memory: saved.memory, effort: saved.effort } : {}),
      ...(assignment === "reranker" ? { reranker: saved.reranker } : {}),
      ...(assignment === "pdf" ? { pdf: saved.pdf, pdfEffort: saved.pdfEffort, allowPdf: saved.allowPdf } : {})
    }));
    setNotice("Assignment saved for future work.");
    void Promise.resolve(onMutationCommitted?.()).catch(() => undefined);
  };
  const verify = async () => {
    if (!verifyModel || busy) return;
    setBusy(true); setError(null); setNotice(null);
    const result = await verifyAdminSystemModelRole(verifyModel, verifyRole);
    setBusy(false);
    if (!result.ok) { setError(adminSystemModelPolicyErrorMessage(result.error)); return; }
    setCatalog(result.data);
    setNotice("Selected role verified. Assignments and other drafts are unchanged.");
  };
  const selectedMemory = catalog?.verificationCandidates.find((item) => item.id === draft.memory) ??
    (catalog?.policy.systemModel?.id === draft.memory ? catalog.policy.systemModel : null);
  const selectedPdf = catalog?.verificationCandidates.find((item) => item.id === draft.pdf) ??
    (catalog?.policy.chatPdfModel?.id === draft.pdf ? catalog.policy.chatPdfModel : null);
  const visionCandidates = catalog?.documentCandidates.filter((item) => item.visionInput === "verified") ?? [];
  function options(items: readonly { id: string; displayName: string; connectionDisplayName: string; connectionId: string }[],
    selected: { id: string; displayName: string; connectionDisplayName: string; connectionId: string } | null | undefined) {
    return <><option value="">Not assigned</option>
      {selected && !items.some((item) => item.id === selected.id)
        ? <option disabled value={selected.id}>Unavailable — {label(selected)}</option> : null}
      {items.map((item) => <option key={item.id} value={item.id}>{label(item)}</option>)}</>;
  }
  function reasoning(model: AdminSystemModelCandidate | null | undefined, value: string, key: "effort" | "pdfEffort") {
    return <label className="grid gap-1.5 text-sm text-ink-secondary">{key === "effort" ? "Memory reasoning effort" : "Chat PDF reasoning effort"}
      <select className={inputClass} disabled={busy || !model} value={value}
        onChange={(event) => setDraft((previous) => ({ ...previous, [key]: event.target.value }))}>
        <option value="">Provider default</option>
        {value && !model?.reasoningEfforts.includes(value) ? <option disabled value={value}>Unavailable — {value}</option> : null}
        {model?.reasoningEfforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
      </select>
    </label>;
  }
  function status(model: { available: boolean; displayName: string; connectionId: string; connectionDisplayName: string } | null) {
    return <p className="text-sm text-ink-secondary" role="status">Current: {model ? label(model) + (model.available ? " · Ready" : " · Unavailable — verify the current deployment") : "Not assigned"}.</p>;
  }
  const changed = (keys: (keyof Draft)[]) => keys.some((key) => draft[key] !== current[key]);
  return (
    <section aria-labelledby="system-models-heading" className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      <div className="max-w-3xl">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-trace-subtle pb-4">
          <div>
            <h2 className="text-lg font-semibold text-ink" id="system-models-heading">System Models</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-secondary">Assign verified deployments to independent internal roles. Providers manages connections and credentials. Chat answer selection remains separate.</p>
          </div>
          <button className={quietButton} disabled={busy} onClick={() => discard(() => void refresh())} type="button">Refresh roles</button>
        </div>
        {error ? <p className="mt-4 text-sm text-critical" role="alert">{error}</p> : null}
        {notice ? <p className="mt-4 text-sm text-positive" role="status">{notice}</p> : null}
        {!catalog ? <p className="mt-5 text-sm text-ink-muted" role="status">{busy ? "Loading system models…" : "System Models is unavailable. Refresh to retry."}</p> : <>
          <section aria-labelledby="memory-model-heading" className="grid gap-4 py-6">
            <h3 className="text-base font-semibold text-ink" id="memory-model-heading">Memory and semantic work</h3>
            <p className="text-sm leading-6 text-ink-secondary">Requires verified strict Structured Output and forced exact-action calls. Also serves the existing structured title and MCP routing helpers. Changes apply to future work; accepted Memory executions retain their binding.</p>
            {status(catalog.policy.systemModel)}
            {catalog.policy.systemModel ? <p className="text-xs leading-5 text-ink-muted">
              Structured Output: {verificationLabel(catalog.policy.systemModel.structuredOutput)}.
              {" "}Exact actions: {verificationLabel(catalog.policy.systemModel.forcedToolCall)}.
            </p> : null}
            <label className="grid gap-1.5 text-sm text-ink-secondary">Memory semantic model
              <select className={inputClass} disabled={busy} value={draft.memory} onChange={(event) => {
                const memory = event.target.value;
                setDraft((previous) => ({ ...previous, memory, effort: "" }));
              }}>{options(catalog.candidates, catalog.policy.systemModel)}</select>
            </label>
            {reasoning(selectedMemory, draft.effort, "effort")}
            <button className={primaryButton + " justify-self-start"} disabled={busy || !changed(["memory", "effort"]) ||
              Boolean(draft.memory && !catalog.candidates.some((item) => item.id === draft.memory))}
              onClick={() => void save("memory")} type="button">Save Memory role</button>
          </section>
          <section aria-labelledby="chat-pdf-model-heading" className="grid gap-4 border-t border-trace-subtle py-6">
            <h3 className="text-base font-semibold text-ink" id="chat-pdf-model-heading">Chat PDF preparation</h3>
            <p className="text-sm leading-6 text-ink-secondary">Requires verified image input. With permission, sends PDF page images and native page text to this deployment. Future messages use this setting; the selected chat model writes the answer.</p>
            {status(catalog.policy.chatPdfModel)}
            {catalog.policy.chatPdfModel ? <p className="text-xs leading-5 text-ink-muted">
              Image input: {verificationLabel(catalog.policy.chatPdfModel.visionInput)}.
            </p> : null}
            <label className="grid gap-1.5 text-sm text-ink-secondary">Chat PDF model
              <select className={inputClass} disabled={busy} value={draft.pdf} onChange={(event) => {
                const pdf = event.target.value;
                setDraft((previous) => ({ ...previous, pdf, pdfEffort: "" }));
              }}>{options(visionCandidates, catalog.policy.chatPdfModel)}</select>
            </label>
            {reasoning(selectedPdf, draft.pdfEffort, "pdfEffort")}
            <label className="flex min-h-11 items-center gap-3 text-sm text-ink-secondary">
              <input type="checkbox" disabled={busy} checked={draft.allowPdf} onChange={(event) => {
                const allowPdf = event.target.checked; setDraft((previous) => ({ ...previous, allowPdf }));
              }} />Allow chat PDF preparation at this destination
            </label>
            <button className={primaryButton + " justify-self-start"} disabled={busy || !changed(["pdf", "pdfEffort", "allowPdf"]) ||
              Boolean(draft.pdf && !visionCandidates.some((item) => item.id === draft.pdf))}
              onClick={() => void save("pdf")} type="button">Save chat PDF role</button>
          </section>
          <section aria-labelledby="reranker-model-heading" className="grid gap-4 border-t border-trace-subtle py-6">
            <h3 className="text-base font-semibold text-ink" id="reranker-model-heading">Memory and Knowledge reranking</h3>
            <p className="text-sm leading-6 text-ink-secondary">Requires a dedicated reranker with a verified complete score response. Changes affect future ranking operations and do not reindex documents.</p>
            {status(catalog.policy.rerankerModel)}
            <label className="grid gap-1.5 text-sm text-ink-secondary">Reranking model
              <select className={inputClass} disabled={busy} value={draft.reranker} onChange={(event) => {
                const reranker = event.target.value; setDraft((previous) => ({ ...previous, reranker }));
              }}>{options(catalog.rerankerCandidates, catalog.policy.rerankerModel)}</select>
            </label>
            {catalog.policy.rerankerRoute?.entries.length ? <p className="text-xs leading-5 text-ink-muted">
              Current authorized route: {catalog.policy.rerankerRoute.entries.map((item) => label(item) + (item.available ? "" : " (unavailable)")).join(" → ")}
            </p> : null}
            <button className={primaryButton + " justify-self-start"} disabled={busy || !changed(["reranker"]) ||
              Boolean(draft.reranker && !catalog.rerankerCandidates.some((item) => item.id === draft.reranker))}
              onClick={() => void save("reranker")} type="button">Save reranking role</button>
          </section>
          <details className="border-t border-trace-subtle py-4">
            <summary className="cursor-pointer text-sm font-semibold text-ink">Verify a deployment for a role</summary>
            <div className="mt-4 grid gap-3">
              <label className="grid gap-1.5 text-sm text-ink-secondary">Role to verify
                <select className={inputClass} disabled={busy} value={verifyRole} onChange={(event) => setVerifyRole(event.target.value as SystemModelVerificationRole)}>
                  <option value="memory">Memory — Structured Output and exact actions</option>
                  <option value="direct_pdf">Knowledge — Direct PDF</option>
                  <option value="vision">Document processing — Vision</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-sm text-ink-secondary">Deployment to verify
                <select className={inputClass} disabled={busy} value={verifyModel} onChange={(event) => setVerifyModel(event.target.value)}>
                  <option value="">Choose a deployment</option>
                  {catalog.verificationCandidates.map((item) => <option key={item.id} value={item.id}>{label(item)}</option>)}
                </select>
              </label>
              <p className="text-xs leading-5 text-ink-muted">Sends bounded synthetic requests through the installation credential and configured route. Only the selected role is checked. Configure and test embedding or reranker deployments in Providers.</p>
              <button className={quietButton + " justify-self-start"} disabled={busy || !verifyModel} onClick={() => void verify()} type="button">Verify selected role (paid request)</button>
            </div>
          </details>
        </>}
        <AdminKnowledgeModelAssignments active={active} onMutationCommitted={onMutationCommitted} />
        <p className="border-t border-trace-subtle pt-4 text-xs leading-5 text-ink-muted">Personal Memory embedding destinations remain bound to each owner’s existing settings and index generation. Changing Knowledge embeddings does not migrate personal Memory.</p>
        <a className={quietButton + " mt-3"} href="/admin">Manage provider deployments</a>
      </div>
    </section>
  );
}
