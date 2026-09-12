"use client";

import { randomUUID } from "@/lib/browser/randomUUID";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { UiV2Button } from "@/components/ui-v2";
import { formatAttachmentBytes } from "@/components/app-shell/attachmentLimitUsage";
import {
  WORKSPACE_SECRET_FILE_MAX_BYTES, WORKSPACE_SECRET_KINDS, WORKSPACE_SECRET_MAX_COUNT,
  WORKSPACE_BROWSER_SESSION_MAX_COUNT,
  workspaceSecretErrorMessage, type WorkspaceSecretKind, type WorkspaceSecretMutation,
  type WorkspaceSecretSummary, type WorkspaceSecretValue
} from "@/lib/contracts/workspaceSecrets";
import { requestWorkspaceSecrets } from "./workspaceSecretsApi";

const labels: Record<WorkspaceSecretKind, string> = { ssh_key: "SSH key", env: "Environment variables", text: "Text", file: "File", browser_session: "Browser session" };
const field = "w-full min-w-0 rounded-lg border border-trace bg-answer-paper px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60";
type Draft = {
  original: WorkspaceSecretSummary | null;
  kind: WorkspaceSecretKind;
  name: string;
  description: string;
  replace: boolean;
  privateKey: string;
  passphrase: string;
  text: string;
  entries: { id: string; name: string; value: string }[];
  fileName: string;
  base64: string | null;
};

function blankDraft(original: WorkspaceSecretSummary | null = null): Draft {
  return { original, kind: original?.kind ?? "ssh_key", name: original?.name ?? "", description: original?.description ?? "",
    replace: !original, privateKey: "", passphrase: "", text: "", entries: [{ id: randomUUID(), name: "", value: "" }], fileName: "", base64: null };
}

function content(draft: Draft): WorkspaceSecretValue {
  switch (draft.kind) {
    case "ssh_key": return { kind: "ssh_key", privateKey: draft.privateKey, passphrase: draft.passphrase };
    case "env": return { kind: "env", entries: draft.entries.map(({ name, value }) => ({ name, value })) };
    case "text": return { kind: "text", text: draft.text };
    case "file":
    case "browser_session":
      if (draft.base64 === null) throw new Error("Choose a file to save.");
      return { kind: draft.kind, originalName: draft.fileName, base64: draft.base64 };
  }
}

export function WorkspaceSecretsPanel({ onBusyChange, onDirtyChange }: Readonly<{
  onBusyChange?(busy: boolean): void;
  onDirtyChange?(dirty: boolean): void;
}>) {
  const [secrets, setSecrets] = useState<readonly WorkspaceSecretSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const active = useRef(false);
  const pending = useRef(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const headings = useRef(new Map<string, HTMLHeadingElement>());
  const restoreFocus = useRef<string | null>(null);
  const formId = draft ? draft.original?.id ?? "new" : null;

  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    requestWorkspaceSecrets(undefined, controller.signal).then((rows) => {
      if (active.current && !controller.signal.aborted) { setSecrets(rows); setError(null); setLoading(false); }
    }, () => { if (active.current && !controller.signal.aborted) { setError("Workspace secrets could not be loaded."); setLoading(false); } });
    return () => { active.current = false; controller.abort(); };
  }, []);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { onDirtyChange?.(Boolean(draft)); return () => onDirtyChange?.(false); }, [draft, onDirtyChange]);
  useEffect(() => {
    if (formId) nameInput.current?.focus();
    else if (restoreFocus.current) {
      (headings.current.get(restoreFocus.current) ?? addButton.current)?.focus();
      restoreFocus.current = null;
    }
  }, [formId, secrets]);

  function change(patch: Partial<Draft>) { setDraft((current) => current ? { ...current, ...patch } : current); }
  function open(original: WorkspaceSecretSummary | null) {
    const next = blankDraft(original);
    if (!original && secrets.filter((entry) => entry.kind !== "browser_session").length >= WORKSPACE_SECRET_MAX_COUNT) next.kind = "browser_session";
    setError(null); setNotice(null); setDeleting(null); setDraft(next);
  }
  function close() {
    restoreFocus.current = draft?.original?.id ?? "add";
    setDraft(null); setError(null);
  }

  async function refresh() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const rows = await requestWorkspaceSecrets();
      if (!active.current) return;
      setSecrets(rows);
      setDraft((current) => {
        if (!current?.original) return current;
        const latest = rows.find(({ id, kind }) => id === current.original!.id && kind === current.kind);
        return latest ? { ...current, original: latest } : current;
      });
    } catch (failure) { if (active.current) setError(failure instanceof Error ? failure.message : workspaceSecretErrorMessage(null)); }
    finally { pending.current = false; if (active.current) { setBusy(false); setLoading(false); } }
  }

  async function mutate(mutation: WorkspaceSecretMutation) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const rows = await requestWorkspaceSecrets(mutation);
      if (!active.current) return;
      restoreFocus.current = mutation.action === "delete" ? "add" : mutation.action === "update" ? mutation.id
        : rows.find(({ id }) => !secrets.some((old) => old.id === id))?.id ?? "add";
      setSecrets(rows); setDraft(null); setDeleting(null);
      setNotice(mutation.action === "delete" ? "Secret deleted. Future requests will use the updated set." : "Secret saved. Available automatically in your personal Workspace requests.");
    } catch (failure) { if (active.current) setError(failure instanceof Error ? failure.message : workspaceSecretErrorMessage(null)); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft || pending.current) return;
    try {
      void mutate(draft.original ? { action: "update", id: draft.original.id, expectedVersionId: draft.original.versionId,
        name: draft.name, description: draft.description,
        value: draft.replace ? { action: "replace", content: content(draft) } : { action: "preserve" }
      } : { action: "create", name: draft.name, description: draft.description, value: content(draft) });
    } catch (failure) { setError(failure instanceof Error ? failure.message : workspaceSecretErrorMessage(null)); }
  }

  async function upload(file: File | undefined, key: boolean) {
    if (!file || pending.current) return;
    if (file.size > (key ? 32 * 1024 : WORKSPACE_SECRET_FILE_MAX_BYTES)) {
      setError(key ? "SSH keys can be up to 32 KiB." : "Files can be up to 512 KiB."); return;
    }
    pending.current = true; setBusy(true); setError(null);
    try {
      if (key) {
        const privateKey = await file.text();
        if (active.current) change({ privateKey });
      } else {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
        if (active.current) change({ fileName: file.name, base64: btoa(binary) });
      }
    } catch { if (active.current) setError("The selected file could not be read. Choose it again."); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }

  const browserCount = secrets.filter((entry) => entry.kind === "browser_session").length;
  const ordinaryCount = secrets.length - browserCount;
  return <section className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-6" aria-labelledby="workspace-secrets-heading" data-testid="workspace-secrets-panel">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1"><h3 className="text-base font-semibold text-ink" id="workspace-secrets-heading">Workspace secrets</h3>
        <p className="mt-1 text-sm leading-6 text-ink-secondary">These secrets are available to the model and programs inside your personal Workspaces. Saving a secret makes it available automatically when Workspace is on.</p>
        <p className="mt-1 text-xs leading-5 text-ink-muted">Shared Projects do not receive these secrets. Changes apply to the next accepted request.</p>
        <p className="mt-2 text-xs leading-5 text-ink-muted">Browser sessions are saved automatically after work in Workspace and contain sign-in cookies. Delete a session to remove that saved sign-in from your next Workspace request. You can also import a session after signing in manually.</p>
      </div>
      <UiV2Button type="button" disabled={busy || loading} icon="regenerate" onClick={() => void refresh()}>Refresh</UiV2Button>
    </div>
    {error ? <p className="mt-4 break-words text-sm text-critical" role="alert">{error}</p> : null}
    {notice ? <p className="mt-4 text-sm text-positive" role="status">{notice}</p> : null}
    {loading ? <p className="mt-5 text-sm text-ink-muted" role="status">Loading Workspace secrets…</p> : null}
    {draft ? <form className="mt-5 border-t border-trace-subtle pt-5" onSubmit={submit} aria-label={draft.original ? "Edit Workspace secret" : "Add Workspace secret"}>
      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4">
        <legend className="mb-4 text-sm font-semibold text-ink">{draft.original ? "Edit secret" : "Add secret"}</legend>
        <label className="grid gap-1.5 text-xs font-medium text-ink-secondary">Type
          <select aria-label="Type" className={field} disabled={Boolean(draft.original)} value={draft.kind} onChange={(event) => change({ kind: event.target.value as WorkspaceSecretKind })}>
            {WORKSPACE_SECRET_KINDS.map((kind) => <option key={kind} value={kind} disabled={!draft.original && (kind === "browser_session" ? browserCount >= WORKSPACE_BROWSER_SESSION_MAX_COUNT : ordinaryCount >= WORKSPACE_SECRET_MAX_COUNT)}>{labels[kind]}</option>)}
          </select>
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-ink-secondary">Name
          <input autoComplete="off" className={field} maxLength={120} ref={nameInput} required value={draft.name} onChange={(event) => change({ name: event.target.value })} />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-ink-secondary">Description (optional)
          <textarea aria-label="Description (optional)" className={field} maxLength={2000} rows={2} value={draft.description} onChange={(event) => change({ description: event.target.value })} />
        </label>
        {draft.original ? <label className="flex min-h-touch items-center gap-2 text-sm text-ink-secondary">
          <input type="checkbox" checked={draft.replace} onChange={(event) => change({ replace: event.target.checked })} />Replace saved value
        </label> : null}
        {!draft.replace ? <p className="text-xs text-ink-muted">The saved value is preserved and is never shown here.</p> : draft.kind === "ssh_key" ? <>
          <label className="grid gap-1.5 text-xs font-medium text-ink-secondary">Private SSH key
            <textarea aria-label="Private SSH key" autoComplete="off" spellCheck={false} className={`${field} font-mono`} rows={6} required value={draft.privateKey} onChange={(event) => change({ privateKey: event.target.value })} />
          </label>
          <label className="grid gap-1.5 text-xs text-ink-secondary">Or upload a private key<input className="w-full min-w-0 text-xs" type="file" onChange={(event) => void upload(event.target.files?.[0], true)} /></label>
          <label className="grid gap-1.5 text-xs font-medium text-ink-secondary">Key passphrase (if encrypted)
            <input autoComplete="new-password" className={field} type="password" value={draft.passphrase} onChange={(event) => change({ passphrase: event.target.value })} />
          </label>
          <p className="text-xs leading-5 text-ink-muted">A private key is enough; no public key or host mapping is needed. You can save several named keys and choose one by its path in SECRETS.md.</p>
        </> : draft.kind === "env" ? <div className="flex flex-col gap-3">
          <p className="text-xs leading-5 text-ink-muted">Values are kept exactly, including newlines. Up to 128 KiB across all environment groups. SSH_AUTH_SOCK, SSH_AGENT_PID and GIT_SSH_COMMAND are reserved.</p>
          {draft.entries.map((entry, index) => <div className="grid min-w-0 gap-2 border-l-2 border-trace-subtle pl-3" key={entry.id}>
            <label className="grid gap-1.5 text-xs font-medium text-ink-secondary">Variable name {index + 1}<input autoComplete="off" spellCheck={false} className={`${field} font-mono`} required value={entry.name} onChange={(event) => change({ entries: draft.entries.map((row) => row.id === entry.id ? { ...row, name: event.target.value } : row) })} /></label>
            <label className="grid gap-1.5 text-xs font-medium text-ink-secondary">Variable value {index + 1}<textarea aria-label={`Variable value ${index + 1}`} autoComplete="off" spellCheck={false} className={`${field} font-mono`} rows={2} value={entry.value} onChange={(event) => change({ entries: draft.entries.map((row) => row.id === entry.id ? { ...row, value: event.target.value } : row) })} /></label>
            {draft.entries.length > 1 ? <UiV2Button type="button" className="self-start" onClick={() => change({ entries: draft.entries.filter(({ id }) => id !== entry.id) })}>Remove variable {index + 1}</UiV2Button> : null}
          </div>)}
          <UiV2Button type="button" className="self-start" disabled={draft.entries.length >= 64} onClick={() => change({ entries: [...draft.entries, { id: randomUUID(), name: "", value: "" }] })}>Add variable</UiV2Button>
        </div> : draft.kind === "text" ? <label className="grid gap-1.5 text-xs font-medium text-ink-secondary">Secret text
          <textarea aria-label="Secret text" autoComplete="off" spellCheck={false} className={field} rows={6} required value={draft.text} onChange={(event) => change({ text: event.target.value })} />
        </label> : <><label className="grid gap-1.5 text-xs font-medium text-ink-secondary">{draft.kind === "browser_session" ? "Browser session JSON" : "Original file"}
          <input aria-label={draft.kind === "browser_session" ? "Browser session JSON" : "Original file"} accept={draft.kind === "browser_session" ? ".json,application/json" : undefined} className="w-full min-w-0 text-xs" type="file" onChange={(event) => void upload(event.target.files?.[0], false)} />
          <span className="break-all text-xs text-ink-muted">{draft.fileName || "Up to 512 KiB; original bytes are preserved."}</span>
        </label>{draft.kind === "browser_session" ? <>
          <label className="grid gap-1.5 text-xs font-medium text-ink-secondary">Session filename<input className={field} required value={draft.fileName} onChange={(event) => change({ fileName: event.target.value })} /></label>
          <p className="text-xs leading-5 text-ink-muted">Import a Playwright storage_state JSON file with cookies and origins. Use a filename such as shop.example.json so Workspace can find the right site. Up to 50 browser sessions, each up to 512 KiB.</p>
        </> : null}</>}
        <div className="flex flex-wrap gap-2"><UiV2Button tone="primary" type="submit">{busy ? "Saving…" : "Save secret"}</UiV2Button><UiV2Button type="button" onClick={close}>Cancel</UiV2Button></div>
      </fieldset>
    </form> : <>
      <UiV2Button type="button" className="mt-5" disabled={busy || loading || ordinaryCount >= WORKSPACE_SECRET_MAX_COUNT && browserCount >= WORKSPACE_BROWSER_SESSION_MAX_COUNT} icon="plus" onClick={() => open(null)} ref={addButton}>Add secret</UiV2Button>
      {!loading && !secrets.length && !error ? <p className="mt-5 text-sm text-ink-muted">No saved Workspace secrets.</p> : null}
      <ul className="mt-4 divide-y divide-trace-subtle" aria-label="Saved Workspace secrets">
        {secrets.map((secret) => <li className="flex flex-wrap items-start gap-3 py-4" key={secret.id}>
          <div className="min-w-0 flex-1"><h4 className="break-words text-sm font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" tabIndex={-1} ref={(node) => { if (node) headings.current.set(secret.id, node); else headings.current.delete(secret.id); }}>{secret.name}</h4>
            <p className="mt-1 text-xs text-ink-muted">{labels[secret.kind]} · <time dateTime={secret.updatedAt}>{new Date(secret.updatedAt).toLocaleString()}</time></p>
            {secret.browserSession ? <p className="mt-1 text-xs text-ink-secondary">{secret.browserSession.autoSaved ? "Saved by Workspace" : "Imported"} · {formatAttachmentBytes(secret.byteSize)}</p> : null}
            {secret.description ? <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-ink-secondary">{secret.description}</p> : null}
            {secret.envNames.length ? <p className="mt-1 break-all font-mono text-xs text-ink-muted">{secret.envNames.join(", ")}</p> : null}
            {secret.originalName ? <p className="mt-1 break-all text-xs text-ink-muted">{secret.originalName}</p> : null}
          </div>
          {deleting === secret.id ? <div className="flex flex-wrap items-center gap-2 text-xs text-ink-secondary"><span>Delete this secret?</span><UiV2Button type="button" disabled={busy} tone="destructive" onClick={() => void mutate({ action: "delete", id: secret.id, expectedVersionId: secret.versionId })}>Delete permanently</UiV2Button><UiV2Button type="button" disabled={busy} onClick={() => setDeleting(null)}>Keep secret</UiV2Button></div>
            : <div className="flex gap-2"><UiV2Button type="button" disabled={busy} aria-label={`Edit ${secret.name}`} onClick={() => open(secret)}>Edit</UiV2Button><UiV2Button type="button" disabled={busy} aria-label={`Delete ${secret.name}`} onClick={() => setDeleting(secret.id)}>Delete</UiV2Button></div>}
        </li>)}
      </ul>
    </>}
  </section>;
}
