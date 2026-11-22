/**
 * The one seam between past-chat search and the installation's past-chat
 * embedding role (`SystemModelPolicy.embeddingProviderModelId`). The indexer
 * embeds documents and the search tools embed queries through it, so both
 * always use the same model and never borrow another role's
 * (`agent_docs/PROVIDERS.md`). The Prisma-backed implementation records the
 * provider-reported usage of every call, failed ones included, after the call:
 * `memory_indexing` for documents, `memory_retrieval` for queries.
 */

/** The role's state. "unset" and "unavailable" are distinct and never replaced by another model. */
export type ChatSearchEmbeddingModel =
  | Readonly<{ kind: "unset" }>
  | Readonly<{ kind: "unavailable"; providerModelId: string; code: string }>
  | Readonly<{ kind: "model"; providerModelId: string }>;

export type ChatSearchEmbedRequest = Readonly<{
  /** The model `currentModel()` returned; a call for another model is refused. */
  providerModelId: string;
  mode: "document" | "query";
  texts: readonly string[];
  /** The owner whose text this is: usage is recorded for them. */
  userId: string;
  latencyClass: "background" | "interactive";
  signal?: AbortSignal;
}>;

export type ChatSearchEmbedResult = Readonly<{
  vectors: readonly (readonly number[])[];
  dimension: number;
}>;

/** Thrown for a failed call; `code` is content-free and fits `ChatSearchState.lastErrorCode`. */
export class ChatSearchEmbeddingError extends Error {
  constructor(readonly code: string, readonly retryAfterMs: number | null = null) {
    super(code);
    this.name = "ChatSearchEmbeddingError";
  }
}

export type ChatSearchEmbedder = Readonly<{
  currentModel(): Promise<ChatSearchEmbeddingModel>;
  embed(request: ChatSearchEmbedRequest): Promise<ChatSearchEmbedResult>;
}>;
