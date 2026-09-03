import { shellFetch } from "@/components/app-shell/shellApi";
import {
  decodeKnowledgeCitationLibraryTargetResponse,
  decodeKnowledgeCitationViewerResponse,
  decodeKnowledgeSourceViewerResponse,
  type KnowledgeCitationViewer,
  type KnowledgeSourceViewer
} from "@/lib/contracts/knowledgeCitations";

export class KnowledgeViewerApiError extends Error {
  constructor(readonly status: number) {
    super("knowledge_reference_not_available");
    this.name = "KnowledgeViewerApiError";
  }
}

export type KnowledgeCitationReference = Readonly<{
  handle: string;
  messageId: string;
  runId: string;
}>;

function citationPath(reference: KnowledgeCitationReference): string {
  return [
    "/api/runs",
    encodeURIComponent(reference.runId),
    "messages",
    encodeURIComponent(reference.messageId),
    "citations",
    encodeURIComponent(reference.handle)
  ].join("/");
}

function sourcePath(sourceId: string): string {
  return `/api/me/knowledge-sources/${encodeURIComponent(sourceId)}/viewer`;
}

async function responseValue(response: Response): Promise<unknown> {
  if (!response.ok) throw new KnowledgeViewerApiError(response.status);
  try {
    return await response.json();
  } catch {
    throw new KnowledgeViewerApiError(response.status);
  }
}

export async function loadKnowledgeCitationViewer(
  reference: KnowledgeCitationReference,
  signal?: AbortSignal
): Promise<KnowledgeCitationViewer> {
  const value = await responseValue(await shellFetch(citationPath(reference), {
    method: "GET",
    ...(signal ? { signal } : {})
  }));
  const decoded = decodeKnowledgeCitationViewerResponse(value);
  if (!decoded || decoded.citation.handle !== reference.handle) {
    throw new KnowledgeViewerApiError(502);
  }
  return decoded.citation;
}

export async function loadKnowledgeCitationLibraryTarget(
  reference: KnowledgeCitationReference,
  signal?: AbortSignal
): Promise<string> {
  const value = await responseValue(await shellFetch(`${citationPath(reference)}?asset=library`, {
    method: "GET",
    ...(signal ? { signal } : {})
  }));
  const decoded = decodeKnowledgeCitationLibraryTargetResponse(value);
  if (!decoded) throw new KnowledgeViewerApiError(502);
  return decoded.sourceId;
}

export async function loadKnowledgeSourceViewer(
  sourceId: string,
  signal?: AbortSignal
): Promise<KnowledgeSourceViewer> {
  const value = await responseValue(await shellFetch(sourcePath(sourceId), {
    method: "GET",
    ...(signal ? { signal } : {})
  }));
  const decoded = decodeKnowledgeSourceViewerResponse(value);
  if (!decoded) throw new KnowledgeViewerApiError(502);
  return decoded.source;
}

export function knowledgeCitationOriginalUrl(reference: KnowledgeCitationReference): string {
  return `${citationPath(reference)}?asset=original`;
}

export function knowledgeCitationPageUrl(reference: KnowledgeCitationReference): string {
  return `${citationPath(reference)}?asset=page`;
}

export function knowledgeSourceOriginalUrl(sourceId: string): string {
  return `${sourcePath(sourceId)}?asset=original`;
}

export function knowledgeSourcePageUrl(sourceId: string, page: number): string {
  return `${sourcePath(sourceId)}?asset=page&page=${page}`;
}
