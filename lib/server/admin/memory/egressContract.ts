import { z } from "zod";

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

export type AdminMemoryEgressAcknowledgeInput = Readonly<{
  currentFingerprint: string;
  expectedVersion: number;
}>;

const acknowledgeSchema = z.strictObject({
  currentFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
});

export function decodeAdminMemoryEgressAcknowledgeInput(
  value: unknown
): AdminMemoryEgressAcknowledgeInput | null {
  const decoded = acknowledgeSchema.safeParse(value);
  return decoded.success ? decoded.data : null;
}
