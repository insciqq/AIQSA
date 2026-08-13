"use client";

import {
  UiV2Button,
  UiV2Icon,
  UiV2IconButton,
  type UiV2IconName
} from "@/components/ui-v2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import { useState } from "react";
import { createPortal } from "react-dom";
import {
  artifactByteSizeLabel,
  artifactFormatLabel,
  artifactVersionLabel,
  boundArtifactVersion
} from "./artifactModel";
import type {
  GeneratedArtifactEventKind,
  GeneratedArtifactPagePreview,
  GeneratedArtifactProjection,
  GeneratedArtifactTablePreview,
  GeneratedArtifactVersion
} from "./contracts";

type ArtifactAction = (
  artifact: GeneratedArtifactProjection,
  version: GeneratedArtifactVersion
) => void;

function artifactIcon(format: GeneratedArtifactProjection["format"]): UiV2IconName {
  if (format === "xlsx") return "table";
  if (format === "pptx") return "slides";
  return "file";
}

function lifecycleLabel(kind: GeneratedArtifactEventKind): string {
  if (kind === "generated_file_detected") return "Creating file";
  if (kind === "generated_file_validating") return "Validating file";
  if (kind === "generated_file_rendering") return "Rendering preview";
  if (kind === "generated_file_ready") return "Ready";
  return "Failed";
}

function ArtifactLifecycleV2({ artifact }: { artifact: GeneratedArtifactProjection }) {
  return (
    <ol aria-label="File generation stages" className="v2-artifact-lifecycle">
      {artifact.events.map((event) => (
        <li data-state={event.state} key={event.kind}>
          <span aria-hidden="true" />
          {lifecycleLabel(event.kind)}
        </li>
      ))}
    </ol>
  );
}

export function GeneratedArtifactCardV2({
  artifact,
  onDetails,
  onDownload,
  onPreview,
  onRetry,
  onUseInNextMessage
}: Readonly<{
  artifact: GeneratedArtifactProjection;
  onDetails?(artifact: GeneratedArtifactProjection): void;
  onDownload?: ArtifactAction;
  onPreview?: ArtifactAction;
  onRetry?(artifact: GeneratedArtifactProjection): void;
  onUseInNextMessage?: ArtifactAction;
}>) {
  const version = boundArtifactVersion(artifact);

  if (artifact.status === "generating") {
    const activeEvent = artifact.events.find((event) => event.state === "active");
    return (
      <article
        aria-busy="true"
        aria-label={`Generating file ${artifact.name}`}
        className="v2-artifact-card"
        data-state="generating"
      >
        <span className="v2-artifact-icon"><span className="v2-spinner" aria-hidden="true" /></span>
        <span className="v2-artifact-body">
          <strong>{artifact.name}</strong>
          <span>{activeEvent ? `${lifecycleLabel(activeEvent.kind)}…` : "Creating file…"}</span>
          <ArtifactLifecycleV2 artifact={artifact} />
        </span>
      </article>
    );
  }

  if (artifact.status === "cancelled") {
    return (
      <article
        aria-label={`File generation cancelled: ${artifact.name}`}
        className="v2-artifact-card"
        data-state="cancelled"
      >
        <span className="v2-artifact-icon"><UiV2Icon name={artifactIcon(artifact.format)} /></span>
        <span className="v2-artifact-body">
          <strong>{artifact.name}</strong>
          <span>File generation cancelled</span>
        </span>
      </article>
    );
  }

  if (artifact.status === "failed") {
    return (
      <article
        aria-label={`Could not generate file ${artifact.name}`}
        className="v2-artifact-card"
        data-state="failed"
      >
        <span className="v2-artifact-icon"><UiV2Icon name={artifactIcon(artifact.format)} /></span>
        <span className="v2-artifact-body">
          <strong>Could not produce a valid {artifactFormatLabel(artifact.format)}</strong>
          <span className="v2-artifact-failure" role="alert">{artifact.validationFailure}</span>
          <ArtifactLifecycleV2 artifact={artifact} />
        </span>
        <span className="v2-artifact-actions">
          {onDetails ? <UiV2Button onClick={() => onDetails(artifact)}>Details</UiV2Button> : null}
          {onRetry ? <UiV2Button onClick={() => onRetry(artifact)}>Try again</UiV2Button> : null}
        </span>
      </article>
    );
  }

  if (!version) {
    return (
      <article aria-label={`File ${artifact.name} unavailable`} className="v2-artifact-card" data-state="failed">
        <span className="v2-artifact-icon"><UiV2Icon name={artifactIcon(artifact.format)} /></span>
        <span className="v2-artifact-body">
          <strong>{artifact.name}</strong>
          <span className="v2-artifact-failure" role="alert">The exact file version is unavailable.</span>
        </span>
      </article>
    );
  }

  const previewFailed = version.preview.status === "failed";
  const previewReady = version.preview.status === "ready";
  return (
    <article aria-label={`File ${artifact.name}`} className="v2-artifact-card" data-state="ready">
      <span className="v2-artifact-icon"><UiV2Icon name={artifactIcon(artifact.format)} /></span>
      <span className="v2-artifact-body">
        <span className="v2-artifact-name-row">
          <strong>{artifact.name}</strong>
          <span>{artifactVersionLabel(version)}</span>
        </span>
        <span>
          {artifactFormatLabel(version.format)} · {version.structuralSummary} · {artifactByteSizeLabel(version.byteSize)}
        </span>
        {previewFailed ? (
          <span className="v2-artifact-preview-failed">Preview unavailable</span>
        ) : version.preview.status === "rendering" || version.preview.status === "pending" ? (
          <span>Preparing preview…</span>
        ) : null}
      </span>
      <span className="v2-artifact-actions">
        {previewReady && onPreview ? (
          <UiV2Button onClick={() => onPreview(artifact, version)}>Preview</UiV2Button>
        ) : null}
        {version.downloadAvailable && onDownload ? (
          <UiV2Button icon="download" onClick={() => onDownload(artifact, version)}>
            Download
          </UiV2Button>
        ) : null}
        {version.useInNextMessageAvailable && onUseInNextMessage ? (
          <UiV2Button onClick={() => onUseInNextMessage(artifact, version)}>
            Use in next message
          </UiV2Button>
        ) : null}
      </span>
    </article>
  );
}

export function GeneratedArtifactStackV2({
  artifacts,
  ...actions
}: Readonly<{
  artifacts: readonly GeneratedArtifactProjection[];
  onDetails?(artifact: GeneratedArtifactProjection): void;
  onDownload?: ArtifactAction;
  onPreview?: ArtifactAction;
  onRetry?(artifact: GeneratedArtifactProjection): void;
  onUseInNextMessage?: ArtifactAction;
}>) {
  return (
    <section aria-label="Generated files" className="v2-artifact-stack" data-testid="artifact-stack-v2">
      {artifacts.map((artifact) => (
        <GeneratedArtifactCardV2 artifact={artifact} key={artifact.id} {...actions} />
      ))}
    </section>
  );
}

function TablePreview({ preview }: { preview: GeneratedArtifactTablePreview }) {
  const [activeTab, setActiveTab] = useState(preview.activeTab);
  const selectedTab = preview.tabs.find((tab) => tab.label === activeTab) ?? preview.tabs[0];
  return (
    <div className="v2-artifact-table-preview">
      <div aria-label="Workbook sheets" className="v2-artifact-tabs" role="tablist">
        {preview.tabs.map((tab) => (
          <button
            aria-selected={tab.label === selectedTab?.label}
            key={tab.label}
            onClick={() => setActiveTab(tab.label)}
            onKeyDown={(event) => {
              const currentIndex = preview.tabs.findIndex((candidate) => candidate.label === tab.label);
              let nextIndex = currentIndex;
              if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % preview.tabs.length;
              else if (event.key === "ArrowLeft") {
                nextIndex = (currentIndex - 1 + preview.tabs.length) % preview.tabs.length;
              } else if (event.key === "Home") nextIndex = 0;
              else if (event.key === "End") nextIndex = preview.tabs.length - 1;
              else return;
              const nextTab = preview.tabs[nextIndex];
              if (!nextTab) return;
              event.preventDefault();
              setActiveTab(nextTab.label);
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>("[role='tab']")
                .item(nextIndex)
                .focus();
            }}
            role="tab"
            tabIndex={tab.label === selectedTab?.label ? 0 : -1}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div aria-label="Table preview" className="v2-artifact-table-scroll" role="region" tabIndex={0}>
        <table>
          <thead><tr>{selectedTab?.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>
            {selectedTab?.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PagePreview({ preview }: { preview: GeneratedArtifactPagePreview }) {
  return (
    <div className="v2-artifact-page-preview">
      <span>{preview.kind === "slides" ? `Slide ${preview.activePage}` : `Page ${preview.activePage}`} of {preview.pageCount}</span>
      <div>
        <strong>{preview.title}</strong>
        {preview.lines.map((line) => <p key={line}>{line}</p>)}
      </div>
    </div>
  );
}

function PreviewBody({ version }: { version: GeneratedArtifactVersion }) {
  if (version.preview.status !== "ready") {
    return (
      <div className="v2-artifact-preview-unavailable" role="status">
        <strong>Preview unavailable</strong>
        <p>{version.preview.status === "failed" ? version.preview.reason : "The preview is still being prepared."}</p>
      </div>
    );
  }
  return version.preview.content.kind === "table"
    ? <TablePreview preview={version.preview.content} />
    : <PagePreview preview={version.preview.content} />;
}

export function ArtifactPreviewDrawerV2({
  artifact,
  onClose,
  onDownload
}: Readonly<{
  artifact: Extract<GeneratedArtifactProjection, { status: "ready" }>;
  onClose(): void;
  onDownload?: ArtifactAction;
}>) {
  const [selectedVersionId, setSelectedVersionId] = useState(artifact.boundVersionId);
  const selectedVersion = artifact.versions.find((version) => version.id === selectedVersionId)
    ?? artifact.versions.find((version) => version.id === artifact.boundVersionId)
    ?? null;
  const {
    dialogRef,
    initialFocusRef: closeRef,
    onDialogKeyDown,
    portalReady
  } = useModalLayerV2({ onClose });

  const drawer = (
    <div
      className="v2-artifact-preview-scrim"
      data-testid="artifact-preview-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <aside
        aria-label={`File preview: ${artifact.name}`}
        aria-modal="true"
        className="v2-artifact-preview-drawer"
        onKeyDown={onDialogKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <header className="v2-artifact-preview-header">
          <span>
            <small>File preview</small>
            <h2>{artifact.name}</h2>
            {selectedVersion ? (
              <span>{artifactFormatLabel(selectedVersion.format)} · {artifactVersionLabel(selectedVersion)}</span>
            ) : null}
          </span>
          <span className="v2-artifact-preview-header-actions">
            {selectedVersion?.downloadAvailable && onDownload ? (
              <UiV2Button icon="download" onClick={() => onDownload(artifact, selectedVersion)}>
                Download
              </UiV2Button>
            ) : null}
            <UiV2IconButton
              icon="close"
              label="Close preview"
              onClick={onClose}
              ref={closeRef}
            />
          </span>
        </header>
        <div className="v2-artifact-preview-layout">
          <section aria-label="Preview content" className="v2-artifact-preview-canvas">
            {selectedVersion ? <PreviewBody version={selectedVersion} /> : (
              <div className="v2-artifact-preview-unavailable" role="alert">
                <strong>The exact version is unavailable</strong>
              </div>
            )}
          </section>
          <aside aria-label="File versions and lineage" className="v2-artifact-lineage">
            <header>
              <small>Immutable history</small>
              <h3>Versions</h3>
            </header>
            <ol>
              {artifact.versions.map((version) => (
                <li data-current={version.id === selectedVersion?.id || undefined} key={version.id}>
                  <button onClick={() => setSelectedVersionId(version.id)} type="button">
                    <span>
                      <strong>{artifactVersionLabel(version)}</strong>
                      <small>{version.branchLabel}</small>
                    </span>
                    <span>{version.sourceMessageLabel}</span>
                    <small>
                      {version.parentVersionNumber
                        ? `Created from v${version.parentVersionNumber} · `
                        : "Original version · "}
                      {version.createdAtLabel}
                    </small>
                  </button>
                </li>
              ))}
            </ol>
          </aside>
        </div>
      </aside>
    </div>
  );

  return portalReady ? createPortal(drawer, document.body) : null;
}
