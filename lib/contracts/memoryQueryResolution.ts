import { z } from "zod";

export const MEMORY_QUERY_RESOLUTION_SCHEMA_VERSION =
  "memory-query-resolution-v1" as const;
export const MEMORY_QUERY_RESOLUTION_NAME = "MemoryQueryResolution" as const;
export const MEMORY_QUERY_RESOLUTION_MAX_CONSTRAINTS = 6 as const;
export const MEMORY_QUERY_RESOLUTION_MAX_SOURCE_TEXTS = 8 as const;
export const MEMORY_QUERY_RESOLUTION_MAX_QUOTE_LENGTH = 500 as const;
export const MEMORY_QUERY_RESOLUTION_MAX_TARGET_LENGTH = 200 as const;
export const MEMORY_QUERY_RESOLUTION_MAX_OCCURRENCE_INDEX = 31 as const;

export const MEMORY_QUERY_CONSTRAINT_KINDS = [
  "AVOID",
  "PREFER",
  "PRESERVE"
] as const;
export type MemoryQueryConstraintKind =
  (typeof MEMORY_QUERY_CONSTRAINT_KINDS)[number];

const boundedText = (maximum: number) => z.string()
  .min(1)
  .max(maximum)
  .refine((value) => value === value.trim() && !value.includes("\u0000"));

const sourceHandleSchema = z.string().regex(/^R[1-9][0-9]{0,2}$/u);
const occurrenceIndexSchema = z.number().int().min(0)
  .max(MEMORY_QUERY_RESOLUTION_MAX_OCCURRENCE_INDEX);

const constraintWireSchema = z.object({
  basisOccurrenceIndex: occurrenceIndexSchema,
  basisQuote: boundedText(MEMORY_QUERY_RESOLUTION_MAX_QUOTE_LENGTH),
  kind: z.enum(MEMORY_QUERY_CONSTRAINT_KINDS),
  sourceHandle: sourceHandleSchema,
  sourceTextIndex: z.number().int().min(0)
    .max(MEMORY_QUERY_RESOLUTION_MAX_SOURCE_TEXTS - 1),
  targetOccurrenceIndex: occurrenceIndexSchema,
  targetQuote: boundedText(MEMORY_QUERY_RESOLUTION_MAX_TARGET_LENGTH)
}).strict();

const resolutionWireSchema = z.object({
  constraints: z.array(constraintWireSchema)
    .max(MEMORY_QUERY_RESOLUTION_MAX_CONSTRAINTS),
  status: z.enum(["NONE", "RESOLVED"])
}).strict().superRefine((value, context) => {
  if (
    value.status === "NONE" && value.constraints.length !== 0 ||
    value.status === "RESOLVED" && value.constraints.length === 0
  ) {
    context.addIssue({
      code: "custom",
      message: "resolution status does not match constraints"
    });
  }
  const identities = value.constraints.map((constraint) => [
    constraint.kind,
    constraint.sourceHandle,
    constraint.sourceTextIndex,
    constraint.targetOccurrenceIndex,
    constraint.targetQuote
  ].join("\u0000"));
  if (new Set(identities).size !== identities.length) {
    context.addIssue({ code: "custom", message: "duplicate query constraint" });
  }
});

export type MemoryQueryResolution = Readonly<{
  constraints: readonly Readonly<{
    basisOccurrenceIndex: number;
    basisQuote: string;
    kind: MemoryQueryConstraintKind;
    sourceHandle: string;
    sourceTextIndex: number;
    targetOccurrenceIndex: number;
    targetQuote: string;
  }>[];
  status: "NONE" | "RESOLVED";
}>;

export type MemoryQueryResolutionDecodeResult =
  | Readonly<{ ok: true; value: MemoryQueryResolution }>
  | Readonly<{ code: "memory_query_resolution_invalid"; ok: false }>;

export function decodeMemoryQueryResolution(
  value: unknown
): MemoryQueryResolutionDecodeResult {
  const decoded = resolutionWireSchema.safeParse(value);
  return decoded.success
    ? { ok: true, value: decoded.data }
    : { code: "memory_query_resolution_invalid", ok: false };
}

export const MEMORY_QUERY_RESOLUTION_JSON_SCHEMA = Object.freeze({
  additionalProperties: false,
  properties: {
    constraints: {
      items: {
        additionalProperties: false,
        properties: {
          basisOccurrenceIndex: {
            maximum: MEMORY_QUERY_RESOLUTION_MAX_OCCURRENCE_INDEX,
            minimum: 0,
            type: "integer"
          },
          basisQuote: {
            maxLength: MEMORY_QUERY_RESOLUTION_MAX_QUOTE_LENGTH,
            minLength: 1,
            type: "string"
          },
          kind: { enum: [...MEMORY_QUERY_CONSTRAINT_KINDS], type: "string" },
          sourceHandle: {
            maxLength: 4,
            minLength: 2,
            pattern: "^R[1-9][0-9]{0,2}$",
            type: "string"
          },
          sourceTextIndex: {
            maximum: MEMORY_QUERY_RESOLUTION_MAX_SOURCE_TEXTS - 1,
            minimum: 0,
            type: "integer"
          },
          targetOccurrenceIndex: {
            maximum: MEMORY_QUERY_RESOLUTION_MAX_OCCURRENCE_INDEX,
            minimum: 0,
            type: "integer"
          },
          targetQuote: {
            maxLength: MEMORY_QUERY_RESOLUTION_MAX_TARGET_LENGTH,
            minLength: 1,
            type: "string"
          }
        },
        required: [
          "basisOccurrenceIndex",
          "basisQuote",
          "kind",
          "sourceHandle",
          "sourceTextIndex",
          "targetOccurrenceIndex",
          "targetQuote"
        ],
        type: "object"
      },
      maxItems: MEMORY_QUERY_RESOLUTION_MAX_CONSTRAINTS,
      type: "array"
    },
    status: { enum: ["NONE", "RESOLVED"], type: "string" }
  },
  required: ["constraints", "status"],
  type: "object"
} as const);
