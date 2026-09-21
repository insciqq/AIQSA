"use client";

import { useState } from "react";
import { ARTIFACT_LIMITS, type ArtifactPublicationSummary, type ArtifactVersionSummary } from "@/lib/contracts/artifacts";
import { UiV2Button, UiV2IconButton } from "@/components/ui-v2";

type VersionSet = Extract<ArtifactPublicationSummary, { mode: "version_set" }>;

export function ArtifactPublicationVersions({ publication, versions, busy, onAdd, onRemove, onDefault, onReorder }: {
  publication: VersionSet;
  versions: readonly ArtifactVersionSummary[];
  busy: boolean;
  onAdd(id: string): void;
  onRemove(id: string): void;
  onDefault(id: string): void;
  onReorder(ids: string[]): void;
}) {
  const [candidate, setCandidate] = useState("");
  const remaining = versions.filter(version => !publication.versions.some(member => member.id === version.id));
  const adding = remaining.some(version => version.id === candidate) ? candidate : "";
  function move(index: number, direction: -1 | 1) {
    const ids = publication.versions.map(version => version.id);
    const other = index + direction;
    if (other < 0 || other >= ids.length) return;
    [ids[index], ids[other]] = [ids[other]!, ids[index]!];
    onReorder(ids);
  }
  return <section aria-label="Published versions" className="v2-artifact-version-editor">
    <p>Only these versions are public. New edits stay private.</p>
    <ol aria-label="Published versions" className="v2-artifact-published-versions">
      {publication.versions.map((version, index) => {
        const isDefault = version.id === publication.defaultVersionId;
        return <li aria-label={`v${version.versionNumber}`} key={version.id}>
          <div className="v2-artifact-member-title"><strong>v{version.versionNumber}</strong><span title={version.title}>{version.title}</span>{isDefault ? <small>Default</small> : null}</div>
          <div className="v2-artifact-member-actions">
            <UiV2Button aria-label={`Make v${version.versionNumber} default`} disabled={busy || isDefault} onClick={() => onDefault(version.id)} type="button">Make default</UiV2Button>
            <UiV2IconButton disabled={busy || index === 0} icon="arrow-up" label={`Move v${version.versionNumber} up`} onClick={() => move(index, -1)} />
            <UiV2IconButton className="v2-artifact-move-down" disabled={busy || index === publication.versions.length - 1} icon="arrow-up" label={`Move v${version.versionNumber} down`} onClick={() => move(index, 1)} />
            <UiV2Button aria-label={`Remove v${version.versionNumber}`} disabled={busy || isDefault || publication.versions.length === 1}
              title={isDefault ? "Choose another default version before removing this one." : undefined} onClick={() => onRemove(version.id)} type="button">Remove</UiV2Button>
          </div>
        </li>;
      })}
    </ol>
    <p className="v2-artifact-note">Choose another default before removing it. To close the entire link, use Revoke.</p>
    <div className="v2-artifact-share-actions">
      <label className="v2-artifact-field v2-artifact-expiry">Add a version<select className="v2-focusable" disabled={busy || publication.versions.length >= ARTIFACT_LIMITS.maxPublicationVersions} onChange={event => setCandidate(event.target.value)} value={adding}>
        <option value="">Choose a private version</option>{remaining.map(version => <option key={version.id} value={version.id}>v{version.versionNumber} · {version.title}</option>)}
      </select></label>
      <UiV2Button disabled={busy || !adding || publication.versions.length >= ARTIFACT_LIMITS.maxPublicationVersions} onClick={() => onAdd(adding)} type="button">Add version</UiV2Button>
    </div>
    {publication.versions.length >= ARTIFACT_LIMITS.maxPublicationVersions ? <p className="v2-artifact-note">This link has the maximum of {ARTIFACT_LIMITS.maxPublicationVersions} published versions.</p> : null}
  </section>;
}
