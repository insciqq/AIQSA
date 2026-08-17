"use client";

import { MarkdownMessage } from "@/components/chat/MarkdownMessage";
import { UiV2Button, UiV2Chip, UiV2Icon } from "@/components/ui-v2";
import type {
  ThreadArtifactSummary,
  ThreadKnowledgeCitation,
  ThreadSearchSource
} from "@/lib/contracts/chats";
import type { ProjectKnowledgeCitationWire } from "@/lib/contracts/projects";
import { useId, useMemo, useState, type ReactNode } from "react";
import { GeminiSearchSuggestionsV2 } from "./GeminiSearchSuggestionsV2";
import { MemoryActionConfirmationV2 } from "./MemoryActionConfirmationV2";
import { presentSearchSourcesV2 } from "./sourcePresentation";

function safeAnswerHref(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.startsWith("//") ||
    /[\u0000-\u001F\u007F\s]/u.test(value)
  ) {
    return null;
  }
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
      ? value
      : null;
  } catch {
    return null;
  }
}

function answerWebSources(artifact: ThreadArtifactSummary): readonly ThreadSearchSource[] {
  const citationSources = artifact.citations.map((citation) => ({
    rank: citation.index,
    ...(citation.snippet ? { snippet: citation.snippet } : {}),
    title: citation.title,
    url: citation.url
  }));
  return [...artifact.sources, ...citationSources];
}

type KnowledgeCitationLoader = (
  citation: ThreadKnowledgeCitation
) => Promise<ProjectKnowledgeCitationWire>;

function KnowledgeSourceV2({
  citation,
  index,
  loadCitation
}: Readonly<{
  citation: ThreadKnowledgeCitation;
  index: number;
  loadCitation?: KnowledgeCitationLoader;
}>) {
  const detailId = useId();
  const [detail, setDetail] = useState<ProjectKnowledgeCitationWire | null>(null);
  const [status, setStatus] = useState<"error" | "idle" | "loading" | "open">("idle");

  const toggle = async () => {
    if (!loadCitation || status === "loading") return;
    if (status === "open") {
      setStatus("idle");
      return;
    }
    if (detail) {
      setStatus("open");
      return;
    }
    setStatus("loading");
    try {
      const loaded = await loadCitation(citation);
      if (loaded.handle !== citation.handle) throw new Error("project_citation_malformed");
      setDetail(loaded);
      setStatus("open");
    } catch {
      setDetail(null);
      setStatus("error");
    }
  };

  return (
    <li>
      <span className="v2-answer-source-index">{index}</span>
      <div>
        {loadCitation ? (
          <button
            aria-controls={detailId}
            aria-expanded={status === "open"}
            className="v2-answer-knowledge-link"
            disabled={status === "loading"}
            type="button"
            onClick={() => void toggle()}
          >
            {citation.fileName}
          </button>
        ) : <strong>{citation.fileName}</strong>}
        <small>{citation.baseName} · page {citation.page}</small>
        {status === "loading" ? (
          <small id={detailId} role="status">Checking Project access…</small>
        ) : null}
        {status === "error" ? (
          <small className="v2-answer-output-error" id={detailId} role="status">
            This source is no longer available in the Project.
          </small>
        ) : null}
        {status === "open" && detail ? (
          <div className="v2-answer-knowledge-detail" id={detailId}>
            <small>Accepted passage · stored with this answer</small>
            <blockquote>{detail.text}</blockquote>
            {detail.textTruncated ? <small>Passage truncated at run time.</small> : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function SourcesV2({ artifact, loadKnowledgeCitation }: Readonly<{
  artifact: ThreadArtifactSummary;
  loadKnowledgeCitation?: KnowledgeCitationLoader;
}>) {
  const presented = useMemo(
    () => presentSearchSourcesV2(answerWebSources(artifact)),
    [artifact]
  );
  const knowledge = artifact.knowledgeCitations ?? [];
  const count = presented.sources.length + knowledge.length;
  if (count === 0) return null;

  return (
    <details className="v2-answer-sources" data-testid="answer-sources">
      <summary aria-label={`Sources, ${count} item${count === 1 ? "" : "s"}`}>
        <UiV2Icon name="library" />
        <span>Sources</span>
      </summary>
      <div className="v2-answer-sources-body">
        {presented.sources.length > 0 ? (
          <ol className="v2-answer-source-list">
            {presented.sources.map((source, index) => {
              const href = safeAnswerHref(source.url);
              return (
                <li key={`${source.rank}:${source.url}:${index}`}>
                  <span className="v2-answer-source-index">{index + 1}</span>
                  <span>
                    {href ? (
                      <a href={href} rel="noreferrer" target="_blank">{source.title}</a>
                    ) : (
                      <span data-testid="unsafe-source-title">{source.title}</span>
                    )}
                    {source.domain && source.domain !== source.title ? (
                      <small>{source.domain}</small>
                    ) : null}
                    {source.snippet ? <small>{source.snippet}</small> : null}
                  </span>
                </li>
              );
            })}
          </ol>
        ) : null}
        {knowledge.length > 0 ? (
          <ol className="v2-answer-knowledge-sources" aria-label="Knowledge sources">
            {knowledge.map((citation, index) => (
              <KnowledgeSourceV2
                citation={citation}
                index={presented.sources.length + index + 1}
                key={`${citation.handle}:${index}`}
                loadCitation={loadKnowledgeCitation}
              />
            ))}
          </ol>
        ) : null}
      </div>
    </details>
  );
}

export function ReasoningV2({ texts }: Readonly<{ texts: readonly string[] }>) {
  const content = texts.map((text) => text.trim()).filter(Boolean).join("\n\n");
  if (!content) return null;
  return (
    <details className="v2-live-reasoning" data-testid="answer-reasoning">
      <summary>Reasoning</summary>
      <div className="v2-live-reasoning-body">
        <MarkdownMessage content={content} />
      </div>
    </details>
  );
}

export function AnswerOutputsV2({
  artifact,
  identitySlot = null,
  loadKnowledgeCitation,
  showReasoning
}: Readonly<{
  artifact: ThreadArtifactSummary | null;
  identitySlot?: ReactNode;
  loadKnowledgeCitation?: KnowledgeCitationLoader;
  showReasoning: boolean;
}>) {
  const hasSources = Boolean(
    artifact && (
      answerWebSources(artifact).length > 0 ||
      (artifact.knowledgeCitations?.length ?? 0) > 0
    )
  );
  const hasSuggestions = artifact?.groundingDisplay?.provider === "gemini";
  const hasReasoning = Boolean(
    artifact && showReasoning && artifact.reasoningText.some((text) => text.trim())
  );
  const hasMemoryAction = Boolean(artifact?.memoryAction);

  if (!identitySlot && !hasSources && !hasSuggestions && !hasReasoning && !hasMemoryAction) {
    return null;
  }

  return (
    <div className="v2-answer-outputs" data-testid="answer-outputs">
      {identitySlot ? <div className="v2-answer-identity">{identitySlot}</div> : null}
      {artifact && hasSources ? (
        <SourcesV2 artifact={artifact} loadKnowledgeCitation={loadKnowledgeCitation} />
      ) : null}
      {artifact?.groundingDisplay?.provider === "gemini" ? (
        <GeminiSearchSuggestionsV2 html={artifact.groundingDisplay.suggestionsHtml} />
      ) : null}
      {artifact && showReasoning ? <ReasoningV2 texts={artifact.reasoningText} /> : null}
      {artifact?.memoryAction ? (
        <MemoryActionConfirmationV2 action={artifact.memoryAction} />
      ) : null}
    </div>
  );
}

const PREVIEW_LIMIT = 4_096;

function boundedPreview(value: unknown): { text: string; truncated: boolean } {
  try {
    const serialized = JSON.stringify(value, null, 2) ?? "Unavailable";
    return serialized.length <= PREVIEW_LIMIT
      ? { text: serialized, truncated: false }
      : { text: `${serialized.slice(0, PREVIEW_LIMIT)}\n…`, truncated: true };
  } catch {
    return { text: "Preview unavailable", truncated: false };
  }
}

export type ToolApprovalStatusV2 =
  | "allowed"
  | "allowing"
  | "error"
  | "pending"
  | "rejected"
  | "rejecting";

export function ToolApprovalCardV2({
  error,
  onAllow,
  onReject,
  redactedArgumentsPreview,
  serverName,
  status,
  toolName
}: Readonly<{
  error?: string | null;
  onAllow(): void;
  onReject(): void;
  redactedArgumentsPreview: unknown;
  serverName: string;
  status: ToolApprovalStatusV2;
  toolName: string;
}>) {
  const preview = useMemo(
    () => boundedPreview(redactedArgumentsPreview),
    [redactedArgumentsPreview]
  );
  const pending = status === "pending" ||
    status === "allowing" ||
    status === "rejecting" ||
    status === "error";

  return (
    <aside className="v2-tool-approval" aria-label={`Approval required for ${serverName} ${toolName}`}>
      <div className="v2-tool-approval-heading">
        <UiV2Icon name="lock" />
        <span>
          <small>Tool approval required</small>
          <strong>{serverName} · {toolName}</strong>
        </span>
        <UiV2Chip tone={
          status === "error"
            ? "danger"
            : status === "allowed"
              ? "ok"
              : status === "rejected"
                ? "warn"
                : "neutral"
        }>
          {status}
        </UiV2Chip>
      </div>
      <p>Review the bounded, redacted preview before this server receives the request.</p>
      <details>
        <summary>Review arguments</summary>
        <pre>{preview.text}</pre>
        {preview.truncated ? <small>Preview truncated at the presentation boundary.</small> : null}
      </details>
      {error ? <p className="v2-answer-output-error" role="alert">{error}</p> : null}
      {pending ? (
        <div className="v2-tool-approval-actions">
          <UiV2Button
            busy={status === "rejecting"}
            disabled={status === "allowing"}
            onClick={onReject}
          >
            Reject
          </UiV2Button>
          <UiV2Button
            busy={status === "allowing"}
            disabled={status === "rejecting"}
            onClick={onAllow}
            tone="primary"
          >
            Allow once
          </UiV2Button>
        </div>
      ) : null}
    </aside>
  );
}
