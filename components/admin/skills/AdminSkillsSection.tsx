"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAdminSectionTopbar } from "@/components/admin/AdminShell";
import { UiV2Button, UiV2IconButton } from "@/components/ui-v2";
import { skillShareStateLabels, skillSharingErrorMessage } from "@/components/skills/skillSharingPresentation";
import type { AdminSkillShareRequestDetail, AdminSkillShareRequestListResponse } from "@/lib/contracts/adminSkills";
import { SKILL_REVIEW_NOTE_MAX_LENGTH, SKILL_SHARE_REQUEST_STATES, type SkillShareRequestState } from "@/lib/contracts/skills";
import { decideAdminSkillRequest, loadAdminSkillFile, loadAdminSkillRequest, loadAdminSkillRequests } from "./adminSkillsApi";

type Props = {
  resource: string | null;
  filter: string | null;
  onSelectResource(id: string | null): void;
  onSelectFilter(filter: string | null): void;
  onMutationCommitted(): void | Promise<unknown>;
};
const date = (value: string) => new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" });
const codeClass = "max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-trace-subtle bg-control-surface p-4 font-mono text-xs leading-6 text-ink-secondary [overflow-wrap:anywhere]";

function RequestList({ state, onSelectFilter, onOpen }: {
  state: SkillShareRequestState;
  onSelectFilter: Props["onSelectFilter"];
  onOpen(id: string): void;
}) {
  const [page, setPage] = useState<AdminSkillShareRequestListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pending = useRef<AbortController | null>(null);
  const failedCursor = useRef<string | undefined>(undefined);
  const load = useCallback((cursor?: string) => {
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    failedCursor.current = cursor;
    return loadAdminSkillRequests(state, cursor, controller.signal).then(result => {
      if (!controller.signal.aborted) setPage(previous => ({ ...result,
        requests: cursor && previous ? [...previous.requests, ...result.requests.filter(item => !previous.requests.some(prior => prior.id === item.id))] : result.requests
      }));
    }).catch(failure => { if (!controller.signal.aborted) setError(skillSharingErrorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
  }, [state]);
  useEffect(() => { void load(); return () => pending.current?.abort(); }, [load]);
  function refresh(cursor?: string) { setLoading(true); setError(null); void load(cursor); }
  return <>
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><h2 className="text-lg font-semibold text-ink">Skill approvals</h2>
        <p className="mt-1 text-sm text-ink-muted">Review instructions and files before they become available to other people and Projects.</p></div>
      <UiV2Button disabled={loading} icon="regenerate" onClick={() => refresh()}>Refresh</UiV2Button>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex items-center gap-2 text-sm text-ink-secondary">Status
        <select aria-label="Approval status" className="min-h-11 rounded-lg border border-trace-subtle bg-control-surface px-3 text-ink"
          value={state} onChange={event => onSelectFilter(event.target.value)}>
          {SKILL_SHARE_REQUEST_STATES.map(value => <option key={value} value={value}>{skillShareStateLabels[value]}</option>)}
        </select>
      </label>
      {page ? <p className="text-sm text-ink-muted">{page.pendingCount.toLocaleString()} awaiting approval</p> : null}
    </div>
    {error ? <div className="flex flex-wrap items-center gap-3 text-sm text-critical" role="alert"><p>{error}</p>
      <UiV2Button disabled={loading} onClick={() => refresh(failedCursor.current)}>Try again</UiV2Button></div> : null}
    {loading && !page ? <p className="text-sm text-ink-muted" role="status">Loading approval requests…</p> : null}
    {page?.requests.length ? <ul aria-label="Skill approval requests" className="divide-y divide-trace-subtle border-y border-trace-subtle">
      {page.requests.map(request => <li key={request.id}>
        <button className="v2-focusable flex min-h-16 w-full flex-wrap items-center justify-between gap-3 px-1 py-4 text-left hover:bg-control-surface"
          onClick={() => onOpen(request.id)} type="button" aria-label={`Review ${request.name} · v${request.revisionNumber}`}>
          <span className="min-w-0 flex-1"><strong className="block break-words text-sm font-semibold text-ink [overflow-wrap:anywhere]">{request.name}</strong>
            <span className="mt-1 block text-xs text-ink-muted">{request.ownerDisplayName} · v{request.revisionNumber} · {date(request.createdAt)}</span></span>
          <span className="text-xs text-ink-secondary">{skillShareStateLabels[request.state]}</span>
        </button>
      </li>)}
    </ul> : page && !error ? <p className="py-8 text-sm text-ink-muted" role="status">No {state === "pending" ? "pending approval" : state} requests.</p> : null}
    {page?.nextCursor ? <div><UiV2Button busy={loading} onClick={() => refresh(page.nextCursor!)}>Load more</UiV2Button></div> : null}
  </>;
}

function RequestDetail({ id, onMutationCommitted }: { id: string; onMutationCommitted: Props["onMutationCommitted"] }) {
  const [detail, setDetail] = useState<AdminSkillShareRequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const active = useRef(true);
  const pending = useRef<AbortController | null>(null);
  const filePending = useRef<AbortController | null>(null);
  const load = useCallback(() => {
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    return loadAdminSkillRequest(id, controller.signal).then(result => { if (!controller.signal.aborted) setDetail(result); })
      .catch(failure => { if (!controller.signal.aborted) setError(skillSharingErrorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
  }, [id]);
  useEffect(() => {
    active.current = true; void load();
    return () => { active.current = false; pending.current?.abort(); filePending.current?.abort(); };
  }, [load]);
  const noteLength = [...note].length;
  function refresh() { setLoading(true); setError(null); void load(); }
  async function decide(action: "approve" | "reject") {
    if (busy || loading || !detail?.canReview || noteLength > SKILL_REVIEW_NOTE_MAX_LENGTH) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await decideAdminSkillRequest(id, { action, ...(note.trim() ? { note: note.trim() } : {}) });
      if (active.current) { setDetail(result); setNote(""); setNotice(action === "approve" ? `Revision v${result.revisionNumber} approved.` : "Request rejected. The previous approved revision is unchanged."); }
      void Promise.resolve().then(onMutationCommitted).catch(() => undefined);
    } catch (failure) { if (active.current) setError(skillSharingErrorMessage(failure)); }
    finally { if (active.current) setBusy(false); }
  }
  async function readFile(path: string) {
    filePending.current?.abort(); const controller = new AbortController(); filePending.current = controller;
    setReading(path); setPreview(null); setPreviewError(null);
    try { const content = await loadAdminSkillFile(id, path, controller.signal); if (!controller.signal.aborted) setPreview({ path, content }); }
    catch (failure) { if (!controller.signal.aborted) setPreviewError(skillSharingErrorMessage(failure)); }
    finally { if (!controller.signal.aborted) setReading(null); }
  }
  return <>
    {error ? <div className="flex flex-wrap items-center gap-3 text-sm text-critical" role="alert"><p>{error}</p>
      <UiV2Button disabled={loading || busy} onClick={() => refresh()}>Refresh request</UiV2Button></div> : null}
    {notice ? <p className="text-sm text-ink-secondary" role="status">{notice}</p> : null}
    {loading && !detail ? <p className="text-sm text-ink-muted" role="status">Loading approval request…</p> : null}
    {detail ? <>
      <header><div className="flex flex-wrap items-center gap-x-4 gap-y-2"><h2 className="break-words text-xl font-semibold text-ink [overflow-wrap:anywhere]">{detail.name}</h2>
        <span className="text-sm text-ink-muted">{skillShareStateLabels[detail.state]}</span></div>
        <p className="mt-2 text-sm text-ink-muted">By {detail.ownerDisplayName} · Requested {date(detail.createdAt)} · Revision v{detail.revisionNumber}</p>
      </header>
      <div className="space-y-2 border-y border-trace-subtle py-4 text-sm text-ink-secondary">
        <p>Approved: {detail.sharedRevision ? `v${detail.sharedRevision.revisionNumber}` : "None"} · Current: {detail.currentRevision ? `v${detail.currentRevision.revisionNumber}` : "Unavailable"}</p>
        {detail.currentRevision && detail.currentRevision.id !== detail.revisionId ? <p className="text-caution">The owner has a newer revision. This decision applies only to v{detail.revisionNumber}.</p> : null}
        <p>Audiences: {detail.audiences.length ? detail.audiences.map(audience => audience.name).join(", ") : "No shared audience yet"}</p>
      </div>
      <section aria-label="Changes from approved revision" className="space-y-3">
        <h3 className="text-sm font-semibold text-ink">Changes from approved revision</h3>
        <p className="text-sm text-ink-secondary">{detail.diff.skillMarkdownChanged ? "SKILL.md has changed." : "SKILL.md is unchanged."}</p>
        {detail.diff.files.length ? <ul className="space-y-2 text-sm text-ink-secondary">{detail.diff.files.map(file => <li key={file.path} className="flex flex-wrap gap-x-2 [overflow-wrap:anywhere]">
          <span className="font-medium capitalize">{file.change}</span><code className="min-w-0 break-all">{file.path}</code>
          {file.executable ? <span className="text-xs text-caution">Executable</span> : null}
          {file.previousExecutable !== undefined && file.previousExecutable !== file.executable ? <span className="text-xs text-ink-muted">Execution permission {file.executable ? "added" : "removed"}</span> : null}
        </li>)}</ul> : <p className="text-sm text-ink-muted">No bundled file changes.</p>}
      </section>
      <section className="space-y-3"><h3 className="text-sm font-semibold text-ink">SKILL.md · v{detail.revisionNumber}</h3>
        <pre aria-label="Requested SKILL.md" className={codeClass} tabIndex={0}>{detail.requestedRevision.skillMarkdown}</pre>
      </section>
      <section className="space-y-3"><h3 className="text-sm font-semibold text-ink">Bundled files</h3>
        <p className="text-xs text-ink-muted">{detail.requestedRevision.bundle.fileCount.toLocaleString()} files · {detail.requestedRevision.bundle.totalBytes.toLocaleString()} bytes including SKILL.md</p>
        {detail.requestedRevision.files.length ? <ul className="divide-y divide-trace-subtle border-y border-trace-subtle">{detail.requestedRevision.files.map(file => <li key={file.path} className="flex min-w-0 items-center justify-between gap-3 py-3">
          <span className="min-w-0 text-sm text-ink-secondary"><code className="break-all">{file.path}</code>
            <small className="mt-1 block text-ink-muted">{file.byteSize.toLocaleString()} bytes{file.executable ? " · Executable" : ""}</small></span>
          {file.kind === "text" ? <UiV2Button aria-label={`View ${file.path}`} busy={reading === file.path} disabled={reading !== null} onClick={() => void readFile(file.path)}>View</UiV2Button>
            : <span className="shrink-0 text-xs text-ink-muted">Binary file</span>}
        </li>)}</ul> : <p className="text-sm text-ink-muted">This revision contains only SKILL.md.</p>}
        {previewError ? <p className="text-sm text-critical" role="alert">{previewError}</p> : null}
        {preview ? <div className="space-y-2"><div className="flex items-center justify-between gap-3"><h4 className="break-all text-sm font-semibold text-ink">{preview.path}</h4>
          <UiV2IconButton icon="close" label="Close file preview" onClick={() => setPreview(null)} /></div>
          <pre aria-label={preview.path} className={codeClass} tabIndex={0}>{preview.content}</pre></div> : null}
      </section>
      {detail.reviewNote ? <section className="space-y-2"><h3 className="text-sm font-semibold text-ink">Review note</h3><p className="whitespace-pre-wrap break-words text-sm text-ink-secondary [overflow-wrap:anywhere]">{detail.reviewNote}</p></section> : null}
      {detail.canReview ? <form className="space-y-3 border-t border-trace-subtle pt-5" onSubmit={event => event.preventDefault()}>
        <label className="block space-y-2 text-sm font-medium text-ink" htmlFor="skill-review-note"><span>Review note <span className="font-normal text-ink-muted">(optional)</span></span>
          <textarea aria-describedby="skill-review-note-count" aria-invalid={noteLength > SKILL_REVIEW_NOTE_MAX_LENGTH || undefined} className="min-h-28 w-full resize-y rounded-lg border border-trace-subtle bg-control-surface p-3 font-normal text-ink outline-none focus-visible:ring-2 focus-visible:ring-focus"
            disabled={busy} id="skill-review-note" value={note} onChange={event => setNote(event.target.value)} />
        </label>
        <p className={`text-xs ${noteLength > SKILL_REVIEW_NOTE_MAX_LENGTH ? "text-critical" : "text-ink-muted"}`} id="skill-review-note-count">{noteLength.toLocaleString()} / {SKILL_REVIEW_NOTE_MAX_LENGTH.toLocaleString()} characters</p>
        <div className="flex flex-wrap gap-2"><UiV2Button busy={busy} disabled={loading || noteLength > SKILL_REVIEW_NOTE_MAX_LENGTH} tone="primary" onClick={() => void decide("approve")}>Approve v{detail.revisionNumber}</UiV2Button>
          <UiV2Button busy={busy} disabled={loading || noteLength > SKILL_REVIEW_NOTE_MAX_LENGTH} tone="destructive" onClick={() => void decide("reject")}>Reject</UiV2Button></div>
      </form> : detail.state === "pending" ? <p className="text-sm text-ink-muted">This Skill is unavailable for review.</p> : null}
    </> : null}
  </>;
}

export function AdminSkillsSection({ resource, filter, onSelectResource, onSelectFilter, onMutationCommitted }: Props) {
  const state = SKILL_SHARE_REQUEST_STATES.includes(filter as SkillShareRequestState) ? filter as SkillShareRequestState : "pending";
  const topbar = useMemo(() => ({ title: resource ? "Skills / Approval request" : "Skills" }), [resource]);
  useAdminSectionTopbar(topbar);
  return <div className="flex max-w-[1120px] min-w-0 flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8" data-testid="admin-skills-section">
    {resource ? <><div><UiV2Button icon="arrow-left" tone="ghost" onClick={() => onSelectResource(null)}>Back to requests</UiV2Button></div>
      <RequestDetail id={resource} key={resource} onMutationCommitted={onMutationCommitted} /></>
      : <RequestList key={state} state={state} onSelectFilter={onSelectFilter} onOpen={onSelectResource} />}
  </div>;
}
