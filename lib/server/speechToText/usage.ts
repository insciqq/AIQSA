import type { Prisma } from "@prisma/client";
import { reportedCostMicros } from "../../domain/usage";
import type { SpeechToTextProviderFamily } from "../../contracts/speechToText";
import type { AudioTranscriptionUsage } from "../providers/audioTranscription";
import { storedTokenUsage } from "../usage";

/**
 * One usage row of a transcription call: a user's dictation (`speech_to_text`,
 * personal) or an administrator's Test (`model_check`). The role has no
 * ProviderModel row and no configured price, so the cost is exactly the
 * provider-reported cost, otherwise unknown. Never audio or text.
 */
export function transcriptionUsageEvent(input: Readonly<{
  family: SpeechToTextProviderFamily;
  modelId: string;
  purpose: "model_check" | "speech_to_text";
  usage: AudioTranscriptionUsage | null;
  userId: string;
}>): Prisma.UsageEventUncheckedCreateInput {
  const usage = input.usage;
  return {
    estimatedCostMicros: usage?.costUsd === null || usage?.costUsd === undefined ? null : reportedCostMicros(usage.costUsd),
    modelId: input.modelId,
    provider: input.family,
    providerModelId: null,
    purpose: input.purpose,
    userId: input.userId,
    ...storedTokenUsage({
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      totalTokens: usage?.totalTokens ?? null
    })
  };
}
