import { logEvent } from "../observability";
import type {
  UploadMimeFamily,
  UploadRefusalOperation,
  UploadRefusalStage,
  UploadSizeClass
} from "../observability/events";

/**
 * What a route may say about a refused upload: the step that refused it, the
 * size it declared or measured and its declared MIME type. Only a size bucket
 * and the MIME family reach the log, never the exact size or the type itself.
 */
export type UploadRefusalFacts = {
  byteSize?: number;
  mimeType?: string | null;
  stage?: UploadRefusalStage;
};

export type UploadRefusal = UploadRefusalFacts & {
  /** The client went away (a cancelled part): the failure is logged at info, with no error projection. */
  clientAborted?: boolean;
  code: string;
  /** Only for an unexpected failure: its content-free projection is logged. */
  error?: unknown;
  operation: UploadRefusalOperation;
  status: number;
};

// Inclusive upper bounds: the default ordinary limit, the largest ordinary
// limit and the largest Workspace upload separate their own buckets.
const SIZE_CLASSES: ReadonlyArray<readonly [number, UploadSizeClass]> = [
  [0, "empty"],
  [1_000_000, "to_1mb"],
  [10_000_000, "to_10mb"],
  [25_000_000, "to_25mb"],
  [67_108_864, "to_64mb"],
  [536_870_912, "to_512mb"]
];

const MIME_FAMILIES: ReadonlySet<string> = new Set<UploadMimeFamily>([
  "application", "audio", "font", "image", "message", "model", "multipart", "text", "video"
]);

export function uploadSizeClass(byteSize: number | undefined): UploadSizeClass | undefined {
  if (typeof byteSize !== "number" || !Number.isFinite(byteSize) || byteSize < 0) return undefined;
  return SIZE_CLASSES.find(([limit]) => byteSize <= limit)?.[1] ?? "over_512mb";
}

export function uploadMimeFamily(mimeType: string | null | undefined): UploadMimeFamily | undefined {
  if (typeof mimeType !== "string") return undefined;
  const declared = mimeType.trim().toLowerCase();
  if (declared === "") return "none";
  const family = /^([a-z]+)\//u.exec(declared)?.[1];
  return family !== undefined && MIME_FAMILIES.has(family) ? family as UploadMimeFamily : "other";
}

/** A request body's declared length, when the header is a plain number. */
export function declaredContentLength(request: Request): number | undefined {
  const value = request.headers.get("content-length");
  return value !== null && /^\d{1,15}$/u.test(value) ? Number(value) : undefined;
}

/** Logs one content-free `upload_refused` record; it never changes the response. */
export function logUploadRefusal(refusal: UploadRefusal): void {
  logEvent("upload_refused", {
    code: refusal.code,
    httpStatus: refusal.status,
    operation: refusal.operation,
    ...(refusal.stage ? { stage: refusal.stage } : {}),
    ...sizeAndFamily(refusal),
    ...(refusal.clientAborted ? { client_aborted: true } : refusal.error !== undefined ? { error: refusal.error } : {})
  });
}

/** The JSON refusal a route returns, logged once with its code. */
export function refuseUpload(refusal: UploadRefusal & {
  body?: Readonly<Record<string, unknown>>;
  headers?: HeadersInit;
}): Response {
  logUploadRefusal(refusal);
  return Response.json(
    { error: refusal.code, ...refusal.body },
    { status: refusal.status, ...(refusal.headers ? { headers: refusal.headers } : {}) }
  );
}

function sizeAndFamily(facts: UploadRefusalFacts): { mime_family?: UploadMimeFamily; size_class?: UploadSizeClass } {
  const sizeClass = uploadSizeClass(facts.byteSize);
  const mimeFamily = uploadMimeFamily(facts.mimeType);
  return {
    ...(sizeClass ? { size_class: sizeClass } : {}),
    ...(mimeFamily ? { mime_family: mimeFamily } : {})
  };
}
