"use client";

import { useEffect, useId, useState } from "react";
import { loadSkillVersions, restoreSkillVersion, SkillRequestError } from "@/components/app-shell/skillLibraryStore";
import { UiV2Button, UiV2Chip } from "@/components/ui-v2";
import type { SkillVersionSummary, SkillVersionsResponse } from "@/lib/contracts/skillVersions";

const COLLAPSED_COUNT = 5;

/** A loaded list, keyed by the request it answers; no entry for the current key means loading. */
type Loaded = Readonly<{ key: string; state: "error" } |
  { key: string; state: "ready"; page: SkillVersionsResponse; older: readonly SkillVersionSummary[]; nextBefore: number | null }>;
type Feedback = Readonly<{ tone: "ok" | "danger"; text: string }>;

function sizeLabel(bytes: number): string {
  if (bytes < 1_024) return `${bytes.toLocaleString()} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / (1_024 * 1_024)).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function restoreFailure(failure: unknown, revisionNumber: number): string {
  const code = failure instanceof SkillRequestError ? failure.issue.code : null;
  if (code === "skill_version_conflict") {
    return `The Skill changed after this list was loaded, so v${revisionNumber} was not restored. The list is up to date now; check it and try again.`;
  }
  if (code === "skill_archived") return "This Skill is archived. Restore it from the archive before restoring an earlier version.";
  if (code === "skill_not_found") return "This Skill or version is no longer available.";
  return `v${revisionNumber} could not be restored. Try again.`;
}

/**
 * The owner's version history of a Skill with Restore: the chosen version's
 * content becomes current as a new version after a confirmation that names
 * it. History is kept and the shared version is unchanged.
 */
export function SkillVersionsSection({ skill, published, disabled = false, onChanged }: Readonly<{
  skill: Readonly<{ id: string; name: string; version: number }>;
  /** The Skill has a version shared with colleagues. */
  published: boolean;
  disabled?: boolean;
  /** The Skill changed (restored here, or found changed): reload its detail. */
  onChanged(): void;
}>) {
  const headingId = useId();
  const [reload, setReload] = useState(0);
  // Any change to the Skill (its version) or a retry is a new list; state of an older one is ignored.
  const key = `${skill.id}:${skill.version}:${reload}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [confirmation, setConfirmation] = useState<Readonly<{ key: string; version: SkillVersionSummary }> | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadSkillVersions(skill.id, undefined, controller.signal)
      .then((page) => { if (!controller.signal.aborted) setLoaded({ key, state: "ready", page, older: [], nextBefore: page.nextBefore }); })
      .catch(() => { if (!controller.signal.aborted) setLoaded({ key, state: "error" }); });
    return () => controller.abort();
  }, [key, skill.id]);

  const load = loaded?.key === key ? loaded : null;
  const confirm = confirmation?.key === key ? confirmation.version : null;
  const setConfirm = (version: SkillVersionSummary | null) => setConfirmation(version ? { key, version } : null);

  async function loadOlder(): Promise<void> {
    if (loadingOlder || load?.state !== "ready" || load.nextBefore === null) return;
    const listKey = key;
    setLoadingOlder(true);
    try {
      const page = await loadSkillVersions(skill.id, load.nextBefore);
      setLoaded((current) => current?.key === listKey && current.state === "ready"
        ? { ...current, older: [...current.older, ...page.versions], nextBefore: page.nextBefore } : current);
    } catch {
      setFeedback({ tone: "danger", text: "Older versions could not be loaded. Try again." });
    } finally {
      setLoadingOlder(false);
    }
  }

  async function restore(version: SkillVersionSummary, expectedVersion: number): Promise<void> {
    if (restoring) return;
    setRestoring(true);
    setFeedback(null);
    try {
      const result = await restoreSkillVersion(skill.id, version.revisionId, expectedVersion);
      setConfirm(null);
      if (result.outcome === "unchanged") {
        setFeedback({ tone: "ok", text: `v${version.revisionNumber} already matches the current version; nothing changed.` });
        return;
      }
      setFeedback({ tone: "ok", text: `v${result.restoredFrom} restored as v${result.revisionNumber}.` });
      onChanged();
    } catch (failure) {
      setConfirm(null);
      setFeedback({ tone: "danger", text: restoreFailure(failure, version.revisionNumber) });
      if (failure instanceof SkillRequestError && ["skill_version_conflict", "skill_archived"].includes(failure.issue.code)) {
        // The detail and this list are stale: show the Skill as it is now.
        setReload((value) => value + 1);
        onChanged();
      }
    } finally {
      setRestoring(false);
    }
  }

  const page = load?.state === "ready" ? load.page : null;
  const versions = load?.state === "ready" ? [...load.page.versions, ...load.older] : [];
  const nextBefore = load?.state === "ready" ? load.nextBefore : null;
  const shown = expanded ? versions : versions.slice(0, COLLAPSED_COUNT);
  const busy = disabled || restoring;
  return (
    <section className="v2-skill-detail-section v2-skill-versions" aria-labelledby={headingId}>
      <h4 id={headingId}>Versions</h4>
      <p>Restoring makes an earlier version current again as a new version. No version is deleted.</p>
      {feedback ? <p className="v2-skill-versions-feedback" data-tone={feedback.tone} role={feedback.tone === "danger" ? "alert" : "status"}>
        {feedback.text}</p> : null}
      {!load ? <p role="status">Loading versions…</p> : null}
      {/* A secondary list that failed to load is not announced over the detail's own alerts. */}
      {load?.state === "error" ? <div className="v2-skill-versions-error">
        <p>Versions could not be loaded.</p>
        <UiV2Button onClick={() => setReload((value) => value + 1)}>Try again</UiV2Button>
      </div> : null}
      {page ? <ol className="v2-skill-versions-list" aria-label={`Versions of ${skill.name}`}>
        {shown.map((version) => (
          <li key={version.revisionId} data-current={version.current || undefined}>
            <div className="v2-skill-version-row">
              <span className="v2-skill-version-copy">
                <span className="v2-skill-version-title">
                  <strong>v{version.revisionNumber}</strong>
                  {version.current ? <UiV2Chip tone="ok">Current</UiV2Chip> : null}
                  {version.shared ? <UiV2Chip>Shared</UiV2Chip> : null}
                </span>
                <small>{dateLabel(version.createdAt)}{version.authorDisplayName ? ` · ${version.authorDisplayName}` : ""}</small>
                <small>{version.fileCount} {version.fileCount === 1 ? "file" : "files"} · {sizeLabel(version.byteSize)}
                  {version.hasExecutables ? " · Runs scripts" : ""}</small>
                {version.restoredFrom ? <small>Restored from v{version.restoredFrom}</small> : null}
                {version.changeNote ? <small className="v2-skill-version-note">{version.changeNote}</small> : null}
              </span>
              {!version.current ? (
                <UiV2Button aria-label={`Restore v${version.revisionNumber}`} disabled={busy || page.archived || confirm !== null}
                  onClick={() => { setFeedback(null); setConfirm(version); }}>Restore…</UiV2Button>
              ) : null}
            </div>
            {confirm?.revisionId === version.revisionId ? (
              <div className="v2-skill-version-confirmation" role="group" aria-label={`Restore v${version.revisionNumber}`}>
                <strong>Restore v{version.revisionNumber} of “{skill.name}”?</strong>
                <p>
                  Its content becomes the current version as a new version. Your later versions stay in history.
                  {published ? " Colleagues keep the shared version until you share again." : ""} Chats and scheduled tasks use
                  it from their next run.
                </p>
                <div className="v2-skill-actions">
                  <UiV2Button busy={restoring} tone="primary" disabled={disabled}
                    onClick={() => void restore(version, page.version)}>{restoring ? "Restoring…" : `Restore v${version.revisionNumber}`}</UiV2Button>
                  <UiV2Button autoFocus disabled={restoring} onClick={() => setConfirm(null)}>Cancel</UiV2Button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ol> : null}
      {page?.archived ? <p>Archived Skills keep their versions. Restore the Skill from the archive to restore a version.</p> : null}
      {page && !expanded && versions.length > COLLAPSED_COUNT ? (
        <div className="v2-skill-actions">
          <UiV2Button onClick={() => setExpanded(true)}>Show {versions.length - COLLAPSED_COUNT} more</UiV2Button>
        </div>
      ) : page && nextBefore !== null ? (
        <div className="v2-skill-actions">
          <UiV2Button busy={loadingOlder} onClick={() => { setExpanded(true); void loadOlder(); }}>
            {loadingOlder ? "Loading…" : "Load older versions"}</UiV2Button>
        </div>
      ) : null}
    </section>
  );
}
