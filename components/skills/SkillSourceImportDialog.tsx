"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { importSkillSource, previewSkillSource, SkillRequestError, skillValidationMessage } from "@/components/app-shell/skillLibraryStore";
import { UiV2Button, UiV2IconButton } from "@/components/ui-v2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import { SKILL_SOURCE_MAX_SELECTIONS, SKILL_SOURCE_URL_MAX_LENGTH, type SkillSourcePreview, type SkillSourceImportRequest } from "@/lib/contracts/skillSources";
import type { SkillDetail, SkillImportResponse } from "@/lib/contracts/skills";

type Choice = { selected: boolean; destination: string };

function sourceError(failure: unknown): string {
  const code = failure instanceof Error ? failure.message : "";
  if (["skill_source_changed", "skill_version_conflict"].includes(code)) {
    return "The source or your Skill changed. Find Skills again before importing.";
  }
  if (["skill_source_url_invalid", "skill_source_request_invalid", "skill_source_unsupported"].includes(code)) {
    return "Use a public GitHub or GitLab link, or a direct HTTPS ZIP or SKILL.md link without credentials or query parameters.";
  }
  if (code === "skill_source_unavailable") {
    return "The source could not be downloaded. Check that the link is public and try again.";
  }
  if (code === "skill_source_timeout") return "The source took too long to respond. Try again.";
  if (code === "skill_source_invalid") return "The downloaded source is not a supported Skill bundle. Check the link or try a ZIP containing SKILL.md.";
  if (code === "skill_source_forbidden") return "This link cannot be accessed. Use a publicly accessible HTTPS source.";
  if (code === "skill_source_rate_limited") return "The source is limiting downloads. Try again later.";
  if (code === "skill_source_too_large") return "This source exceeds the import size limit. Use a smaller repository or ZIP archive.";
  if (code === "skill_source_matches_limit") return "Too many of your Skills share these names. Rename or remove duplicates before importing.";
  if (code === "skill_markdown_required") return "No SKILL.md was found. Choose a Skill folder or a ZIP containing one.";
  if (code === "skill_not_available") return "This Skill is no longer available. Close this window and refresh your library.";
  if (failure instanceof SkillRequestError) return skillValidationMessage(failure.issue);
  return "The request could not be completed. Try finding Skills again.";
}

export function SkillSourceImportDialog({ target, onClose, onImported }: Readonly<{
  target?: SkillDetail;
  onClose(): void;
  onImported(result: SkillImportResponse): void;
}>) {
  const [url, setUrl] = useState(target?.importSource?.url ?? "");
  const [preview, setPreview] = useState<SkillSourcePreview | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [loading, setLoading] = useState(Boolean(target?.importSource));
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const committing = useRef(false);
  const mounted = useRef(false);
  const id = useId();
  const { dialogRef, initialFocusRef, onDialogKeyDown, portalReady } = useModalLayerV2({ closeBlocked: importing, onClose });

  const discover = useCallback((sourceUrl: string) => {
    if (committing.current) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    return previewSkillSource({ url: sourceUrl.trim(), ...(target ? { targetSkillId: target.id } : {}) }, controller.signal).then(result => {
      if (!mounted.current || controller.signal.aborted || pending.current !== controller) return;
      setPreview(result);
      let selectedCount = 0;
      setChoices(Object.fromEntries(result.candidates.map(candidate => {
        const updating = result.target?.path === candidate.path;
        const selected = !candidate.error && (result.target ? updating : candidate.matches.length === 0) && selectedCount < SKILL_SOURCE_MAX_SELECTIONS;
        if (selected) selectedCount++;
        return [candidate.path, {
          selected,
          destination: updating ? result.target!.id : candidate.matches.length ? "" : "create"
        }];
      })));
    }).catch((failure: unknown) => {
      if (mounted.current && !controller.signal.aborted && pending.current === controller) setError(sourceError(failure));
    }).finally(() => {
      if (mounted.current && pending.current === controller) setLoading(false);
    });
  }, [target]);

  useEffect(() => {
    mounted.current = true;
    if (target?.importSource) void discover(target.importSource.url);
    return () => { mounted.current = false; pending.current?.abort(); };
  }, [discover, target]);

  const selections: SkillSourceImportRequest["selections"] = [];
  const selected = preview?.candidates.filter(candidate => choices[candidate.path]?.selected && !candidate.error) ?? [];
  const destinations = new Set<string>();
  let incomplete = false;
  let duplicateTarget = false;
  for (const candidate of selected) {
    const destination = choices[candidate.path]?.destination;
    if (!candidate.bundleDigest || !destination) { incomplete = true; continue; }
    if (destination === "create") {
      selections.push({ path: candidate.path, bundleDigest: candidate.bundleDigest, action: { kind: "create" } });
    } else {
      const match = candidate.matches.find(item => item.id === destination) ?? (preview?.target?.id === destination ? preview.target : undefined);
      if (!match) { incomplete = true; continue; }
      if (destinations.has(match.id)) duplicateTarget = true;
      destinations.add(match.id);
      selections.push({ path: candidate.path, bundleDigest: candidate.bundleDigest, action: { kind: "update", skillId: match.id, version: match.version } });
    }
  }
  const canImport = Boolean(preview && selected.length && selected.length <= SKILL_SOURCE_MAX_SELECTIONS && !incomplete && !duplicateTarget && !loading && !importing);

  async function commit(): Promise<void> {
    if (!canImport || !preview || committing.current) return;
    committing.current = true;
    setImporting(true);
    setError(null);
    try {
      const result = await importSkillSource({ url: preview.source.url, fingerprint: preview.fingerprint, selections });
      if (mounted.current) onImported(result);
    } catch (failure) {
      if (mounted.current) {
        setError(sourceError(failure));
        // Never retry a mutation against the old preview, including ambiguous network outcomes.
        setPreview(null);
        setChoices({});
      }
    } finally {
      committing.current = false;
      if (mounted.current) setImporting(false);
    }
  }

  if (!portalReady) return null;
  return createPortal(
    <div className="v2-skill-dialog-scrim v2-skill-source-scrim" role="presentation" onMouseDown={event => {
      if (!importing && event.currentTarget === event.target) onClose();
    }}>
      <section className="v2-skill-source-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
        ref={dialogRef} onKeyDown={onDialogKeyDown}>
        <header className="v2-skill-dialog-header">
          <h2 id={`${id}-title`}>{target ? "Check Skill updates" : "Import Skills from a link"}</h2>
          <UiV2IconButton ref={initialFocusRef} icon="close" label="Close link import" disabled={importing} onClick={onClose} />
        </header>
        <div className="v2-skill-source-body">
          <p>Choose Skills from a public GitHub or GitLab repository, a ZIP archive, or a direct SKILL.md link.</p>
          <form onSubmit={event => {
            event.preventDefault();
            if (committing.current) return;
            setLoading(true); setPreview(null); setChoices({}); setError(null);
            void discover(url);
          }}>
            <label className="v2-skill-field" htmlFor={`${id}-url`}>
              <span id={`${id}-url-label`}>Source link</span>
              <input id={`${id}-url`} className="v2-focusable" type="url" inputMode="url" required maxLength={SKILL_SOURCE_URL_MAX_LENGTH}
                placeholder="https://github.com/owner/repository/tree/main/skills" spellCheck={false}
                value={url} disabled={importing || Boolean(target)} aria-labelledby={`${id}-url-label`} aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
                onChange={event => {
                  pending.current?.abort();
                  setUrl(event.target.value); setPreview(null); setChoices({}); setLoading(false); setError(null);
                }} />
              <small id={`${id}-help`}>Public HTTPS links only. Repository and ZIP imports include each Skill’s bundled files.</small>
            </label>
            <div className="v2-skill-actions"><UiV2Button type="submit" busy={loading} disabled={importing || !url.trim()}>Find Skills</UiV2Button></div>
          </form>
          {loading ? <p role="status">Downloading the source and finding Skills…</p> : null}
          {error ? <p className="v2-skill-field-error" id={`${id}-error`} role="alert">{error}</p> : null}
          {preview ? <>
            <div className="v2-skill-source-summary" role="status">
              <p>{preview.candidates.length} {preview.candidates.length === 1 ? "Skill found" : "Skills found"} · Source revision <code title={preview.source.revision}>{preview.source.revision.slice(0, 12)}</code></p>
              {preview.candidates.length > SKILL_SOURCE_MAX_SELECTIONS ? <p>Select up to {SKILL_SOURCE_MAX_SELECTIONS} Skills per import.</p> : null}
              {preview.source.kind === "markdown" ? <p>This link imports SKILL.md only. Use a repository folder or ZIP to include references, scripts, and other files.</p> : null}
              {preview.ignoredFiles > 0 ? <p>{preview.ignoredFiles} files outside Skill folders will be skipped.</p> : null}
              {preview.target?.locallyModified ? <p>Your Skill has local changes since its last import.</p> : null}
              {preview.target && !preview.candidates.some(candidate => candidate.path === preview.target!.path) ? <p>The previously imported folder was not found. Choose a Skill and its destination below.</p> : null}
            </div>
            <ul className="v2-skill-source-candidates" aria-label="Skills found at source">
              {preview.candidates.map((candidate, index) => {
                const choice = choices[candidate.path];
                const matches = [...candidate.matches];
                if (preview.target && !matches.some(match => match.id === preview.target!.id)) matches.push(preview.target);
                return <li key={candidate.path}>
                  <label className="v2-skill-source-choice">
                    <input type="checkbox" checked={choice?.selected ?? false} disabled={importing || Boolean(candidate.error) || (!choice?.selected && selected.length >= SKILL_SOURCE_MAX_SELECTIONS)}
                      aria-label={`Select ${candidate.name} from ${candidate.path}`} onChange={event => {
                        setChoices(current => ({ ...current, [candidate.path]: { ...current[candidate.path], selected: event.target.checked } }));
                      }} />
                    <span><strong>{candidate.name}</strong><small>{candidate.path === "." ? "Source root" : candidate.path}</small></span>
                  </label>
                  {candidate.error ? <p className="v2-skill-field-error">{skillValidationMessage(candidate.error)}</p> : <>
                    {candidate.description ? <p>{candidate.description}</p> : null}
                    <p className="v2-skill-source-file-count">SKILL.md{candidate.fileCount ? ` + ${candidate.fileCount} bundled ${candidate.fileCount === 1 ? "file" : "files"}` : ""} · {candidate.totalBytes.toLocaleString()} bytes{candidate.hasExecutables ? " · Includes scripts" : ""}</p>
                    {matches.length ? <label className="v2-skill-field" htmlFor={`${id}-destination-${index}`}>
                      <span>{candidate.matches.length ? "You already have a Skill with this name" : "Import destination"}</span>
                      <select id={`${id}-destination-${index}`} className="v2-focusable" aria-label={`Import action for ${candidate.name} from ${candidate.path}`}
                        value={choice?.destination ?? ""} disabled={!choice?.selected || importing}
                        onChange={event => setChoices(current => ({ ...current, [candidate.path]: { ...current[candidate.path], destination: event.target.value } }))}>
                        <option value="">Choose an action</option><option value="create">Create a separate Skill</option>
                        {matches.map(match => <option key={match.id} value={match.id}>Update {match.name} (version {match.version})</option>)}
                      </select>
                    </label> : <small>A new Skill will be created.</small>}
                  </>}
                </li>;
              })}
            </ul>
            {incomplete ? <p className="v2-skill-field-error" role="alert">Choose an import action for every selected Skill.</p> : null}
            {duplicateTarget ? <p className="v2-skill-field-error" role="alert">Choose a different destination: two selected Skills cannot update the same Skill.</p> : null}
            {selections.some(selection => selection.action.kind === "update") ? <p className="v2-skill-source-update-note">Updating replaces that Skill’s instructions and bundled files, including local edits. Changes apply to future uses.</p> : null}
          </> : null}
        </div>
        <footer className="v2-skill-source-footer">
          <span>{selected.length ? `${selected.length} selected` : "Choose the Skills to import"}</span>
          <UiV2Button disabled={importing} onClick={onClose}>Cancel</UiV2Button>
          <UiV2Button busy={importing} disabled={!canImport} tone="primary" onClick={() => void commit()}>Import selected</UiV2Button>
        </footer>
      </section>
    </div>, document.body
  );
}
