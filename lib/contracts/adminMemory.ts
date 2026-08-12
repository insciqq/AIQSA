import { z } from "zod";
import { MEMORY_EGRESS_CONSENT_MODES } from "./memory";
import {
  adminMemoryHealthSchema,
  type AdminMemoryHealth
} from "./memoryHealth";

export const ADMIN_MEMORY_DESTINATION_IDS = [
  "answer_provider",
  "system_model",
  "embedding",
  "remote_reranker"
] as const;

export type AdminMemoryDestinationId =
  (typeof ADMIN_MEMORY_DESTINATION_IDS)[number];

export type AdminMemoryDestinationRow = Readonly<{
  destinations: readonly string[];
  id: AdminMemoryDestinationId;
  reviewRequired: boolean;
  state: "AVAILABLE" | "BOUND_PER_RUN" | "UNAVAILABLE";
}>;

export type AdminMemoryEgressSettings = Readonly<{
  acceptedAt: string | null;
  acceptedBy: Readonly<{ displayName: string; id: string }> | null;
  acceptedFingerprint: string | null;
  acceptedPolicyVersion: string | null;
  consentMode: "ADMIN" | "PER_USER";
  currentFingerprint: string;
  currentPolicyVersion: string;
  destinations: readonly AdminMemoryDestinationRow[];
  reviewRequired: boolean;
  version: number;
  waitingJobCount: number;
}>;

export type AdminMemoryEgressResponse = Readonly<{
  memoryEgress: AdminMemoryEgressSettings;
  memoryHealth: AdminMemoryHealth;
}>;

export type AdminMemoryEgressAcknowledgeInput = Readonly<{
  currentFingerprint: string;
  expectedVersion: number;
}>;

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const policyVersion = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/u);
const destinationRowSchema = z.object({
  destinations: z.array(z.string().trim().min(1).max(256)).max(128),
  id: z.enum(ADMIN_MEMORY_DESTINATION_IDS),
  reviewRequired: z.boolean(),
  state: z.enum(["AVAILABLE", "BOUND_PER_RUN", "UNAVAILABLE"])
}).strict();
const destinationRowsSchema = z.array(destinationRowSchema)
  .length(ADMIN_MEMORY_DESTINATION_IDS.length)
  .refine((rows) => rows.every((row, index) => (
    row.id === ADMIN_MEMORY_DESTINATION_IDS[index] &&
    (row.id === "answer_provider"
      ? row.state === "BOUND_PER_RUN" && !row.reviewRequired && row.destinations.length === 1
      : row.state !== "BOUND_PER_RUN" && (
          row.state === "AVAILABLE"
            ? row.destinations.length > 0
            : row.destinations.length === 0
        ))
  )));

const responseSchema = z.object({
  memoryEgress: z.object({
    acceptedAt: z.string().datetime().nullable(),
    acceptedBy: z.object({
      displayName: z.string().trim().min(1).max(200),
      id: z.string().trim().min(1).max(256)
    }).strict().nullable(),
    acceptedFingerprint: fingerprint.nullable(),
    acceptedPolicyVersion: policyVersion.nullable(),
    consentMode: z.enum(MEMORY_EGRESS_CONSENT_MODES),
    currentFingerprint: fingerprint,
    currentPolicyVersion: policyVersion,
    destinations: destinationRowsSchema,
    reviewRequired: z.boolean(),
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    waitingJobCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  }).strict(),
  memoryHealth: adminMemoryHealthSchema
}).strict();

const acknowledgeSchema = z.object({
  currentFingerprint: fingerprint,
  expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
}).strict();

export function decodeAdminMemoryEgressResponse(
  value: unknown
): AdminMemoryEgressResponse | null {
  const decoded = responseSchema.safeParse(value);
  return decoded.success ? decoded.data : null;
}

export function decodeAdminMemoryEgressAcknowledgeInput(
  value: unknown
): AdminMemoryEgressAcknowledgeInput | null {
  const decoded = acknowledgeSchema.safeParse(value);
  return decoded.success ? decoded.data : null;
}
