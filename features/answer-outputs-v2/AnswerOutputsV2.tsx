"use client";

import { ArtifactShareDialog } from "@/components/artifacts/ArtifactShareDialog";
import { artifactKindLabel } from "@/components/artifacts/artifactPresentation";
import { artifactGenerationStatus, visibleArtifactGenerationAttempts, type ArtifactGenerationDraft } from "@/components/artifacts/artifactGenerationState";
import { ArtifactThumbnailV2 } from "@/components/artifacts/ArtifactThumbnailV2";
import { useArtifactPanelStore } from "@/components/artifacts/artifactPanelStore";
import { UiV2ResponsiveMenu } from "@/components/ui-v2/ResponsiveMenuV2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { ChatImageV2, ChatImageViewerV2 } from "@/features/attachments-v2/ChatImageV2";
import { FilePreviewV2 } from "@/features/library-v2/FilePreviewV2";
import { attachmentPreviewKind } from "@/lib/domain/attachmentPreview";
import { FileActionsMenuV2 } from "@/features/attachments-v2/FileActionsMenuV2";

import { MarkdownMessage } from "@/components/chat/MarkdownMessage";
import { formatAttachmentBytes } from "@/components/app-shell/attachmentLimitUsage";
import { attachmentDownloadHref } from "@/components/app-shell/workspaceClient";
import {
  UiV2Button,
  UiV2Icon,
  UiV2IconButton,
  UiV2MenuItem,
  type UiV2IconName
} from "@/components/ui-v2";
import type {
  ThreadArtifactSummary,
  ThreadGeneratedArtifact
} from "@/lib/contracts/chats";
import type { ThreadGeneratedFile, ThreadWorkspaceOutputStatus } from "@/lib/contracts/workspace";
import { latestGeneratedArtifactsForAnswer } from "@/lib/domain/generatedArtifacts";
import { workspaceOutputStatusCopyV2 } from "@/features/run-lifecycle-v2/workspaceActivityPresentation";
import { useMemo, useRef, useState } from "react";
import { GeminiSearchSuggestionsV2 } from "./GeminiSearchSuggestionsV2";
import type { ResearchReportDownloadV2 } from "./researchAnswerView";
import { ScheduledTaskCardsV2 } from "./ScheduledTaskCardV2";
import { SkillSaveCardsV2 } from "./SkillSaveCardV2";
import { ResourceChangeCardsV2 } from "./ResourceChangeCardV2";
import { McpApprovalCardsV2 } from "./McpApprovalCardV2";
import type { McpApprovalCard, McpApprovalContinuationOutcome } from "@/lib/contracts/mcpApprovals";

/**
 * Quiet status lines between the answer body and its actions row: Gemini
 * search suggestions.
 * The process fold above the text and the Sources chip in the row own the
 * rest of the anatomy.
 */
export function AnswerOutputsV2({
  artifact,
  canSaveFiles = false,
  latestAnswer = false,
  live = false,
  onContinueAfterMcpApproval,
  onEditArtifact,
  onEditScheduledTask,
  onOpenArtifact,
  onOpenFile,
  onOpenLibrary,
  onStartAssistantChat,
  onUseImageInArtifact,
  researchReport = null,
  runId = null,
  workspaceOutputStatus = null
}: Readonly<{
  artifact: ThreadArtifactSummary | null;
  canSaveFiles?: boolean;
  /** The chat's latest answer: only its approval cards offer Continue. */
  latestAnswer?: boolean;
  /** While running, show only already-settled draft downloads and created or managed scheduled tasks. */
  live?: boolean;
  /** Starts the continuation turn after the initiator allowed a refused MCP call. */
  onContinueAfterMcpApproval?(card: McpApprovalCard): void | Promise<McpApprovalContinuationOutcome | void>;
  onEditArtifact?(artifact: ThreadGeneratedArtifact): void | Promise<void>;
  /** Opens a scheduled task the answer created or managed in its editor. */
  onEditScheduledTask?(taskId: string): void | Promise<void>;
  onOpenArtifact?(artifact: ThreadGeneratedArtifact, source: HTMLElement): void;
  /** Opens an output's PDF or text preview in the chat's panel; without it the preview takes the window. */
  onOpenFile?: GeneratedFileOpener;
  /** Opens a Settings address (`/?library=...`) a card links to in the shell. */
  onOpenLibrary?(href: string): void;
  /** Starts a new chat with an Assistant an answer created, as `/assistant/<id>` does. */
  onStartAssistantChat?(assistantId: string): void;
  onUseImageInArtifact?(attachmentId: string): void | Promise<void>;
  /** The whole report of a research that wrote a page (`researchAnswerViewV2`), offered as a `.md` file under the page's card. */
  researchReport?: ResearchReportDownloadV2 | null;
  /** The answer's run: its approval cards decide through it. */
  runId?: string | null;
  /** Export state of the run's Workspace outputs; shown above the generated files. */
  workspaceOutputStatus?: ThreadWorkspaceOutputStatus | null;
}>) {
  const scheduledTasks = artifact?.scheduledTasks ?? [];
  const skillSaves = artifact?.skillSaves ?? [];
  const resourceChanges = artifact?.resourceChanges ?? [];
  const cardNavigation = { onOpenLibrary, onStartAssistantChat };
  const mcpApprovals = artifact?.mcpApprovals ?? [];
  if (live) {
    // A created or changed task, a saved Skill or a changed secret or Assistant already is so: its card does not wait for the answer.
    // A refused call's card shows at once; its decision waits for the answer.
    // Drafts and files attached from the user's computer sit where the settled answer lists its files, as the same
    // element (`key`): their cards and image previews stay in place when it settles.
    const drafts = artifact?.generatedFiles?.filter(file => file.checkpoint || file.source === "computer") ?? [];
    return drafts.length || scheduledTasks.length || skillSaves.length || resourceChanges.length || mcpApprovals.length
      ? <div className="v2-answer-outputs" data-testid="answer-outputs">
        <ScheduledTaskCardsV2 cards={scheduledTasks} live onEdit={onEditScheduledTask} />
        <SkillSaveCardsV2 cards={skillSaves} live onOpenLibrary={onOpenLibrary} />
        <ResourceChangeCardsV2 cards={resourceChanges} live navigation={cardNavigation} />
        <McpApprovalCardsV2 cards={mcpApprovals} live runId={runId} />
        {drafts.length ? <GeneratedFilesV2 key="generated-files" canSave={canSaveFiles} files={drafts} onOpenFile={onOpenFile} previewImages /> : null}
      </div> : null;
  }
  const hasSuggestions = artifact?.groundingDisplay?.provider === "gemini";
  const hasGeneratedImages = (artifact?.generatedImages?.length ?? 0) > 0;
  const hasGeneratedArtifacts = (artifact?.generatedArtifacts?.length ?? 0) > 0;
  const hasGeneratedFiles = (artifact?.generatedFiles?.length ?? 0) > 0;
  const outputStatusCopy = workspaceOutputStatusCopyV2(
    workspaceOutputStatus ?? undefined,
    artifact?.generatedFiles?.filter(file => !file.checkpoint && file.source !== "computer").length ?? 0
  );

  if ((!artifact || (
    !hasSuggestions && !hasGeneratedFiles && !hasGeneratedImages && !hasGeneratedArtifacts && !researchReport &&
    scheduledTasks.length === 0 && skillSaves.length === 0 && resourceChanges.length === 0 && mcpApprovals.length === 0
  )) && !outputStatusCopy) {
    return null;
  }

  return (
    <div className="v2-answer-outputs" data-testid="answer-outputs">
      {outputStatusCopy ? (
        <p
          className="v2-workspace-output-status"
          data-state={workspaceOutputStatus?.state}
          data-testid="workspace-output-status"
          role="status"
        >
          {outputStatusCopy}
        </p>
      ) : null}
      {artifact?.generatedImages?.map((image) => <ChatImageV2 key={image.attachmentId} attachmentId={image.attachmentId} label="Generated image" width={image.width} height={image.height} canSave={canSaveFiles} onUseInArtifact={onUseImageInArtifact ? () => onUseImageInArtifact(image.attachmentId) : undefined} />)}
      {hasGeneratedArtifacts ? <GeneratedArtifactsV2 artifacts={artifact?.generatedArtifacts ?? []} onEditArtifact={onEditArtifact} onOpenArtifact={onOpenArtifact} /> : null}
      {researchReport ? <ResearchReportDownloadRowV2 report={researchReport} /> : null}
      <ScheduledTaskCardsV2 cards={scheduledTasks} onEdit={onEditScheduledTask} />
      <SkillSaveCardsV2 cards={skillSaves} onOpenLibrary={onOpenLibrary} />
      <ResourceChangeCardsV2 cards={resourceChanges} navigation={cardNavigation} />
      <McpApprovalCardsV2 cards={mcpApprovals} offerContinue={latestAnswer} onContinue={onContinueAfterMcpApproval} runId={runId} />
      {hasGeneratedFiles ? (
        <GeneratedFilesV2 key="generated-files" canSave={canSaveFiles} files={artifact?.generatedFiles ?? []} onOpenFile={onOpenFile}
          previewImages />
      ) : null}
      {artifact?.groundingDisplay?.provider === "gemini" ? (
        <GeminiSearchSuggestionsV2 html={artifact.groundingDisplay.suggestionsHtml} />
      ) : null}
    </div>
  );
}

export function ArtifactGenerationCardsV2({ drafts, savedArtifacts = [], onOpen, onOpenArtifact }: Readonly<{
  drafts: readonly ArtifactGenerationDraft[];
  savedArtifacts?: readonly ThreadGeneratedArtifact[];
  onOpen(draftId: string, source: HTMLElement): void;
  onOpenArtifact(artifact: ThreadGeneratedArtifact, source: HTMLElement): void;
}>) {
  const ready = latestGeneratedArtifactsForAnswer(drafts.flatMap(draft => draft.artifact ? [draft.artifact] : []))
    .filter(artifact => !savedArtifacts.some(saved => saved.artifactId === artifact.artifactId));
  const pending = visibleArtifactGenerationAttempts(drafts, savedArtifacts);
  return <>
    {ready.length ? <GeneratedArtifactsV2 artifacts={ready} onOpenArtifact={onOpenArtifact} /> : null}
    {pending.length ? <section className="v2-generated-artifacts" aria-label="Artifact creation"><ul>
      {pending.map(draft => <li className="v2-generated-artifact-card" key={draft.draftId}>
        <button type="button" className="v2-generated-artifact-open v2-focusable" onClick={event => onOpen(draft.draftId, event.currentTarget)} aria-label={`Open artifact code: ${draft.title ?? "Artifact"}`}>
          <span className="v2-generated-artifact-tile" aria-hidden="true">{draft.status === "pending" ? <span className="v2-spinner" /> : <UiV2Icon name="artifact" />}</span>
          <span className="v2-generated-artifact-copy"><strong>{draft.title ?? "Artifact"}</strong><small role="status">{artifactGenerationStatus(draft)}</small></span>
        </button>
      </li>)}
    </ul></section> : null}
  </>;
}

function GeneratedArtifactsV2({ artifacts, onEditArtifact, onOpenArtifact }: Readonly<{
  artifacts: readonly ThreadGeneratedArtifact[];
  onEditArtifact?(artifact: ThreadGeneratedArtifact): void | Promise<void>;
  onOpenArtifact?(artifact: ThreadGeneratedArtifact, source: HTMLElement): void;
}>) {
  const [sharing, setSharing] = useState<ThreadGeneratedArtifact | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  async function edit(artifact: ThreadGeneratedArtifact) {
    if (pending.current) return;
    pending.current = true; setEditing(artifact.versionId); setError(null);
    try { await onEditArtifact?.(artifact); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not prepare this artifact for editing."); }
    finally { pending.current = false; setEditing(null); }
  }
  return (
    <section className="v2-generated-artifacts" aria-label="Artifacts">
      {error ? <p className="v2-generated-artifact-error" role="alert">{error}</p> : null}
      <ul>{artifacts.map(artifact => <GeneratedArtifactCardV2 key={artifact.artifactId} artifact={artifact}
        editing={editing !== null} onEdit={onEditArtifact ? () => void edit(artifact) : undefined}
        onOpen={source => onOpenArtifact?.(artifact, source)} onShare={() => setSharing(artifact)} />)}</ul>
      {sharing ? <ArtifactShareDialog artifactId={sharing.artifactId} versionId={sharing.versionId} versionNumber={sharing.versionNumber} onClose={() => setSharing(null)} /> : null}
    </section>
  );
}

function GeneratedArtifactCardV2({ artifact, editing, onOpen, onEdit, onShare }: Readonly<{
  artifact: ThreadGeneratedArtifact;
  editing: boolean;
  onOpen(source: HTMLElement): void;
  onEdit?(): void;
  onShare(): void;
}>) {
  const open = useArtifactPanelStore(state => state.open);
  const active = open?.artifactId === artifact.artifactId && open.versionId === artifact.versionId;
  const [menuOpen, setMenuOpen] = useState(false);
  const { menuRef, triggerRef, closeForAction } = useMenuDismissalV2({ open: menuOpen, onClose: () => setMenuOpen(false) });
  return <li className="v2-generated-artifact-card" data-active={active || undefined}>
    <button type="button" className="v2-generated-artifact-open v2-focusable" aria-label={`Open artifact: ${artifact.title}`}
      aria-expanded={active} onMouseDown={event => { if (document.activeElement instanceof HTMLTextAreaElement) event.preventDefault(); }}
      onClick={event => onOpen(event.currentTarget)}>
      <ArtifactThumbnailV2 artifactId={artifact.artifactId} versionId={artifact.versionId} kind={artifact.kind} byteSize={artifact.byteSize} />
      <span className="v2-generated-artifact-copy"><strong title={artifact.title}>{artifact.title}</strong><small>{artifactKindLabel(artifact.kind)} · v{artifact.versionNumber}</small></span>
    </button>
    <UiV2IconButton ref={triggerRef} icon="more" label={`Actions for artifact: ${artifact.title}`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)} />
    {menuOpen ? <UiV2ResponsiveMenu anchorRef={triggerRef} menuRef={menuRef} label={`Actions for ${artifact.title}`} onClose={() => setMenuOpen(false)}>
      {onEdit ? <UiV2MenuItem disabled={editing} onClick={() => { closeForAction(); onEdit(); }}>Edit with AI</UiV2MenuItem> : null}
      <UiV2MenuItem onClick={() => { closeForAction(); onShare(); }}>Share…</UiV2MenuItem>
      <a className="v2-menu-item v2-focusable" role="menuitem" download href={`/api/artifacts/${encodeURIComponent(artifact.artifactId)}/versions/${encodeURIComponent(artifact.versionId)}/content?download=zip`} onClick={closeForAction}>Download ZIP</a>
      <a className="v2-menu-item v2-focusable" role="menuitem" href={`/artifacts/${encodeURIComponent(artifact.artifactId)}/versions/${encodeURIComponent(artifact.versionId)}`} target="_blank" rel="noreferrer" onClick={closeForAction}>Open in new tab</a>
    </UiV2ResponsiveMenu> : null}
  </li>;
}

/** How long the report's object address outlives the click: long enough for a slow browser to start the download. */
const REPORT_URL_LIFETIME_MS = 30_000;

/** Saves the report made in this tab from the answer's text: no request, no stored copy. */
export function downloadResearchReportV2(report: ResearchReportDownloadV2): void {
  const url = URL.createObjectURL(new Blob([report.text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = report.fileName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), REPORT_URL_LIFETIME_MS);
}

/** The research's whole report as a file card beside its page, made in the browser from the answer's own text. */
function ResearchReportDownloadRowV2({ report }: Readonly<{ report: ResearchReportDownloadV2 }>) {
  const byteSize = useMemo(() => new TextEncoder().encode(report.text).length, [report.text]);
  return (
    <section className="v2-generated-files" aria-label="Report">
      <ul>
        <li>
          <span className="v2-generated-file-tile" aria-hidden="true"><UiV2Icon name="file-text" /></span>
          <span className="v2-generated-file-copy">
            <strong title={report.fileName}>{report.fileName}</strong>
            <small>Report · MD · {formatAttachmentBytes(byteSize)}</small>
          </span>
          <span className="v2-generated-file-actions">
            <button
              aria-label="Download report (.md)"
              className="v2-generated-file-download v2-focusable"
              data-testid="research-report-download"
              data-tooltip="Download report (.md)"
              onClick={() => downloadResearchReportV2(report)}
              type="button"
            >
              <UiV2Icon name="download" />
            </button>
          </span>
        </li>
      </ul>
    </section>
  );
}

function generatedFileType(file: ThreadGeneratedFile): string {
  const extension = file.fileName.split(".").at(-1)?.toLocaleUpperCase();
  if (extension && extension !== file.fileName.toLocaleUpperCase() && extension.length <= 8) {
    return extension === "GZ" && file.fileName.toLocaleLowerCase().endsWith(".tar.gz")
      ? "TAR.GZ"
      : extension;
  }
  const subtype = file.mimeType.split("/", 2)[1]?.split(";", 1)[0];
  return subtype && subtype.length <= 20 ? subtype.toLocaleUpperCase() : "FILE";
}

const FILE_TYPE_ICONS: Readonly<Record<string, UiV2IconName>> = {
  "7Z": "archive", CSV: "table", DOC: "file-text", DOCX: "file-text", GZ: "archive", HTML: "braces",
  JSON: "braces", KEY: "slides", MD: "file-text", ODP: "slides", ODS: "table", ODT: "file-text",
  PDF: "file-text", PPT: "slides", PPTX: "slides", RTF: "file-text", "TAR.GZ": "archive", TSV: "table",
  TXT: "file-text", XLS: "table", XLSX: "table", XML: "braces", YAML: "braces", YML: "braces", ZIP: "archive"
};

function generatedFileIcon(file: ThreadGeneratedFile, type: string): UiV2IconName {
  return file.mimeType.startsWith("image/") ? "image" : FILE_TYPE_ICONS[type] ?? "file";
}

/** What the authorized preview route can show of this file (the same rule it applies). */
function generatedFilePreviewKind(file: ThreadGeneratedFile) {
  return attachmentPreviewKind({ byteSize: file.byteSize, fileName: file.fileName, mimeType: file.mimeType, status: "ready" });
}

function previewableImageFile(file: ThreadGeneratedFile): boolean {
  return generatedFilePreviewKind(file) === "image";
}

/** A PDF or a text file (Markdown rendered, with its source) opens in the Files viewer through the same route. */
function GeneratedFileViewerV2({ canSave, file, kind, onClose }: Readonly<{
  canSave: boolean; file: ThreadGeneratedFile; kind: "pdf" | "text"; onClose(): void;
}>) {
  const viewed = { byteSize: file.byteSize, canOpenChat: false, id: file.attachmentId, name: file.fileName,
    previewKind: kind, status: "ready" as const };
  return <FilePreviewV2 canSave={canSave} compact file={viewed} group={[viewed]} onClose={onClose}
    onSelect={() => undefined} saved={false} useDisabled={false} />;
}

/** A draft's description and the time it was saved. */
function draftDetails(checkpoint: NonNullable<ThreadGeneratedFile["checkpoint"]>): readonly [string, string] {
  return [checkpoint.description, new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" })
    .format(new Date(checkpoint.createdAt))];
}

/** Generated files as compact cards: Download is the visible verb, saving a
 * copy to Files waits behind "⋯". The type tile also keeps the file text
 * clear of the floating jump control's left lane. A previewable file's name
 * opens its viewer (image, PDF or text); with `previewImages` (an answer's outputs) an image's picture is
 * also shown inline above the cards, as generated images are. A draft the
 * agent saved while it worked keeps the final card's two lines, marked
 * "Draft", so nothing moves when the answer settles; its description and
 * time are the meta line's tooltip, or lines of their own with
 * `describeDrafts` (Export history, where they tell same-named drafts apart). */
/** Opens an output's PDF or text preview elsewhere (the chat's panel); `source` takes focus back when it closes. */
export type GeneratedFileOpener = (file: ThreadGeneratedFile, previewKind: "pdf" | "text", source: HTMLElement) => void;

export function GeneratedFilesV2({ files, canSave = false, describeDrafts = false, onOpenFile, onUseFile, previewImages = false,
  useDisabled = false }: Readonly<{
  files: readonly ThreadGeneratedFile[];
  canSave?: boolean;
  describeDrafts?: boolean;
  onOpenFile?: GeneratedFileOpener;
  onUseFile?(attachmentId: string, fileName: string): void;
  previewImages?: boolean;
  useDisabled?: boolean;
}>) {
  const [viewing, setViewing] = useState<ThreadGeneratedFile | null>(null);
  if (files.length === 0) return null;
  const previews = previewImages ? files.filter(previewableImageFile) : [];
  const viewingKind = viewing ? generatedFilePreviewKind(viewing) : null;
  // A PDF or text file goes to the chat's panel where there is one (operator request 2026-11-20); images keep their viewer.
  const open = (file: ThreadGeneratedFile, source: HTMLElement) => {
    const kind = generatedFilePreviewKind(file);
    if (onOpenFile && (kind === "pdf" || kind === "text")) onOpenFile(file, kind, source);
    else setViewing(file);
  };
  return (
    <section className="v2-generated-files" aria-label="Generated files">
      {previews.map((file) => (
        <ChatImageV2 key={file.attachmentId} attachmentId={file.attachmentId} caption={false} label={file.fileName} />
      ))}
      <ul>
        {files.map((file) => {
          const type = generatedFileType(file);
          const details = file.checkpoint ? draftDetails(file.checkpoint) : null;
          const icon = <UiV2Icon name={generatedFileIcon(file, type)} />;
          return (
            <li key={file.attachmentId}>
              {generatedFilePreviewKind(file) ? (
                // A second, larger pointer target for the name's viewer (operator request 2026-11-20); the name stays the
                // one control keyboards and screen readers use, and it takes focus so closing the viewer returns there.
                <button aria-hidden="true" className="v2-generated-file-tile v2-generated-file-tile-open" tabIndex={-1} type="button"
                  onClick={(event) => {
                    const name = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(".v2-generated-file-name");
                    name?.focus();
                    open(file, name ?? event.currentTarget);
                  }}>{icon}</button>
              ) : <span className="v2-generated-file-tile" aria-hidden="true">{icon}</span>}
              <span className="v2-generated-file-copy">
                {generatedFilePreviewKind(file) ? (
                  <button aria-haspopup={onOpenFile && generatedFilePreviewKind(file) !== "image" ? undefined : "dialog"}
                    className="v2-generated-file-name v2-focusable" onClick={(event) => open(file, event.currentTarget)}
                    title={file.relativePath} type="button">
                    <strong>{file.fileName}</strong>
                  </button>
                ) : <strong title={file.relativePath}>{file.fileName}</strong>}
                <small title={details && !describeDrafts ? details.join("\n") : undefined}>
                  {/* One string: a translated page's text never leaves a node React must remove. */}
                  {`${file.checkpoint ? "Draft · " : ""}${type} · ${formatAttachmentBytes(file.byteSize)}`}
                </small>
                {file.checkpoint && details && describeDrafts ? <>
                  <small className="v2-generated-file-description">{details[0]}</small>
                  <small><time dateTime={file.checkpoint.createdAt}>{details[1]}</time></small>
                </> : null}
              </span>
              <span className="v2-generated-file-actions">
                <a
                  aria-label="Download"
                  className="v2-generated-file-download v2-focusable"
                  data-tooltip="Download"
                  download={file.fileName}
                  href={attachmentDownloadHref(file.attachmentId)}
                >
                  <UiV2Icon name="download" />
                </a>
                {canSave ? <FileActionsMenuV2 attachmentId={file.attachmentId} fileName={file.fileName} /> : null}
                {onUseFile ? <UiV2Button disabled={useDisabled} onClick={() => onUseFile(file.attachmentId, file.fileName)}>Use file</UiV2Button> : null}
              </span>
            </li>
          );
        })}
      </ul>
      {viewing && (viewingKind === "pdf" || viewingKind === "text")
        ? <GeneratedFileViewerV2 canSave={canSave} file={viewing} kind={viewingKind} onClose={() => setViewing(null)} />
        : viewing ? <ChatImageViewerV2 attachmentId={viewing.attachmentId} label={viewing.fileName} onClose={() => setViewing(null)} /> : null}
    </section>
  );
}
