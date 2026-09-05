"use client";

import { useCallback, useEffect, useState } from "react";
import {
  activateAdminKnowledgeProfile, adminKnowledgeErrorMessage, getAdminKnowledgeSettings,
  rollbackAdminKnowledgeProfile
} from "./adminKnowledgeApi";
import { useAdminDraftProtection } from "./AdminDraftProtection";
import { inputClass, primaryButton, quietButton } from "./adminPrimitives";
import type { AdminKnowledgePdfProcessingMode, AdminKnowledgeProfileSettings } from "@/lib/contracts/adminKnowledge";

export function AdminKnowledgeModelAssignments({ active, onMutationCommitted }: Readonly<{
  active: boolean;
  onMutationCommitted?(): void | Promise<unknown>;
}>) {
  const [profile, setProfile] = useState<AdminKnowledgeProfileSettings | null>(null);
  const [embedding, setEmbedding] = useState("");
  const [document, setDocument] = useState("");
  const [mode, setMode] = useState<AdminKnowledgePdfProcessingMode>("local");
  const [revision, setRevision] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const apply = useCallback((next: AdminKnowledgeProfileSettings) => {
    setProfile(next);
    setEmbedding(next.activeRevision?.destination.deploymentId ?? "");
    setDocument(next.activeRevision?.pdfProcessing.destination?.deploymentId ?? "");
    setMode(next.activeRevision?.pdfProcessing.mode ?? "local");
    setRevision("");
    setConfirmed(false);
  }, []);
  const dirty = Boolean(profile && (
    embedding !== (profile.activeRevision?.destination.deploymentId ?? "") ||
    mode !== (profile.activeRevision?.pdfProcessing.mode ?? "local") ||
    (mode !== "local" && document !== (profile.activeRevision?.pdfProcessing.destination?.deploymentId ?? ""))
  ));
  const discard = useAdminDraftProtection({ dirty, pending: dirty && busy, owner: "knowledge-model-assignments",
    onDiscard: () => { if (profile) apply(profile); } });
  const refresh = useCallback(async () => {
    setBusy(true);
    const result = await getAdminKnowledgeSettings();
    setBusy(false);
    if (result.ok) { apply(result.data.profile); setError(null); }
    else setError(adminKnowledgeErrorMessage(result.error));
  }, [apply]);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    queueMicrotask(() => { if (!disposed) void refresh(); });
    return () => { disposed = true; };
  }, [active, refresh]);
  const selected = profile?.availablePdfDestinations.find((item) => item.deploymentId === document);
  const documentEligible = mode === "local" ||
    (mode === "system_model_direct_pdf" ? selected?.directPdf : selected?.vision);
  const eligible = Boolean(documentEligible &&
    profile?.availableDestinations.some((item) => item.deploymentId === embedding));
  const save = async (restore = false) => {
    if (!profile || busy || !confirmed || (restore ? !revision : !eligible)) return;
    setBusy(true); setError(null); setNotice(null);
    const result = restore
      ? await rollbackAdminKnowledgeProfile({ expectedVersion: profile.version, revisionId: revision })
      : await activateAdminKnowledgeProfile({ deploymentId: embedding, documentDeploymentId: mode === "local" ? null : document,
          expectedVersion: profile.version, pdfProcessingMode: mode });
    setBusy(false);
    if (!result.ok) { setError(adminKnowledgeErrorMessage(result.error)); return; }
    apply(result.data.profile);
    setNotice("Knowledge profile activated. Explicit reprocessing and reindexing are queued; accepted runs keep their profile.");
    void Promise.resolve(onMutationCommitted?.()).catch(() => undefined);
  };
  const pdfCandidates = profile?.availablePdfDestinations.filter((item) =>
    mode === "system_model_direct_pdf" ? item.directPdf : item.vision) ?? [];
  return (
    <section aria-labelledby="knowledge-model-assignments-heading" className="border-t border-trace-subtle py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-ink" id="knowledge-model-assignments-heading">Knowledge documents and embeddings</h3>
        <button className={quietButton} disabled={busy} onClick={() => discard(() => void refresh())} type="button">Refresh Knowledge roles</button>
      </div>
      <p className="mt-2 text-sm leading-6 text-ink-secondary">Document processing and search embeddings are activated together in one immutable Knowledge profile. Local PDF processing uses no model.</p>
      {error ? <p className="mt-3 text-sm text-critical" role="alert">{error}</p> : null}
      {notice ? <p className="mt-3 text-sm text-positive" role="status">{notice}</p> : null}
      {!profile ? <p className="mt-3 text-sm text-ink-muted" role="status">{busy ? "Loading Knowledge roles…" : "Knowledge assignments are unavailable."}</p> : (
        <div className="mt-4 grid gap-4">
          <p className="text-sm text-ink-secondary" role="status">
            Current profile: {profile.health.state === "ready" ? "Ready" : profile.health.state === "not_configured" ? "Not configured" : "Unavailable or requires attention"}.
            {" "}Documents: {profile.egress.pdfDestination ?? "Local"}.
            {" "}Embeddings: {profile.egress.embeddingDestination ?? "Not assigned"}.
          </p>
          <label className="grid gap-1.5 text-sm text-ink-secondary">Knowledge PDF processing
            <select className={inputClass} disabled={busy} onChange={(event) => { setMode(event.target.value as AdminKnowledgePdfProcessingMode); setConfirmed(false); }} value={mode}>
              <option value="local">Local — no model</option>
              <option value="system_model_direct_pdf">Direct PDF — verified native PDF input</option>
              <option value="system_model_vision">Vision — verified image input</option>
            </select>
          </label>
          {mode !== "local" ? <label className="grid gap-1.5 text-sm text-ink-secondary">Knowledge document model
            <select className={inputClass} disabled={busy} onChange={(event) => { setDocument(event.target.value); setConfirmed(false); }} value={document}>
              <option value="">Choose a verified document model</option>
              {document && !pdfCandidates.some((item) => item.deploymentId === document)
                ? <option disabled value={document}>Unavailable — {profile.activeRevision?.pdfProcessing.destination?.modelDisplayName ?? "choose another model"}</option> : null}
              {pdfCandidates.map((item) => <option key={item.deploymentId} value={item.deploymentId}>{item.connectionDisplayName} / {item.modelDisplayName}</option>)}
            </select>
            <span className="text-xs text-ink-muted">{mode === "system_model_vision"
              ? "Rendered page images and native page text leave this installation. Activation repeats the real Vision probe."
              : "Original PDF page ranges leave this installation. Current native PDF evidence is required."}</span>
          </label> : null}
          <label className="grid gap-1.5 text-sm text-ink-secondary">Knowledge embedding model
            <select className={inputClass} disabled={busy} onChange={(event) => { setEmbedding(event.target.value); setConfirmed(false); }} value={embedding}>
              <option value="">Choose a verified embedding model</option>
              {embedding && !profile.availableDestinations.some((item) => item.deploymentId === embedding)
                ? <option disabled value={embedding}>Unavailable — {profile.activeRevision?.destination.modelDisplayName}</option> : null}
              {profile.availableDestinations.map((item) => <option key={item.deploymentId} value={item.deploymentId}>{item.connectionDisplayName} / {item.modelDisplayName} · {item.targetDimension} dimensions</option>)}
            </select>
            <span className="text-xs text-ink-muted">Requires compatible document/query embedding modes, finite fixed dimensions and a pinned vector space. Receives normalized document text and search queries.</span>
          </label>
          <p className="text-sm leading-6 text-ink-secondary">Changing document processing explicitly reprocesses documents. Changing the embedding vector space explicitly reindexes Knowledge. Existing indexes stay online until their replacements are ready.</p>
          <label className="flex min-h-11 items-center gap-3 text-sm text-ink-secondary">
            <input checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />
            I authorize the disclosed processing, external requests, and reindexing for this profile.
          </label>
          <button className={primaryButton + " justify-self-start"} disabled={busy || !confirmed || !eligible || !dirty && profile.health.state === "ready"}
            onClick={() => void save()} type="button">Activate Knowledge profile</button>
          {profile.recentRevisions.some((item) => item.id !== profile.activeRevision?.id && item.executionAuthority === "installation") ? (
            <div className="grid gap-2 border-t border-trace-subtle pt-4">
              <label className="grid gap-1.5 text-sm text-ink-secondary">Earlier Knowledge profile
                <select className={inputClass} disabled={busy} value={revision} onChange={(event) => { setRevision(event.target.value); setConfirmed(false); }}>
                  <option value="">Choose an earlier profile</option>
                  {profile.recentRevisions.filter((item) => item.id !== profile.activeRevision?.id && item.executionAuthority === "installation")
                    .map((item) => <option value={item.id} key={item.id}>Revision {item.revisionNumber} · {item.destination.modelDisplayName} · {item.pdfProcessing.destination?.modelDisplayName ?? "Local"}</option>)}
                </select>
              </label>
              <button className={quietButton + " justify-self-start"} disabled={busy || !revision || !confirmed} onClick={() => void save(true)} type="button">Restore Knowledge profile</button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
