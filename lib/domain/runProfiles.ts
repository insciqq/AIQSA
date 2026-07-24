import { RUN_PROFILE_IDS, type RunProfileId } from "../contracts/runProfiles";

export type RunProfileMetadata = Readonly<{
  defaultDescription: string;
  id: RunProfileId;
  label: string;
}>;

export const RUN_PROFILE_METADATA = [
  {
    defaultDescription: "Simple, well-defined questions",
    id: "fast",
    label: "Fast"
  },
  {
    defaultDescription: "Most everyday questions",
    id: "balanced",
    label: "Balanced"
  },
  {
    defaultDescription: "Difficult or open-ended questions",
    id: "deep",
    label: "Deep"
  }
] as const satisfies readonly RunProfileMetadata[];

export const DEFAULT_RUN_PROFILE_CONFIGURATIONS = [
  {
    id: "fast",
    reasoningEffort: "medium",
    reasoningMode: "standard",
    targetTemplateKey: "openai:gpt-5.6-luna"
  },
  {
    id: "balanced",
    reasoningEffort: "medium",
    reasoningMode: "standard",
    targetTemplateKey: "openai:gpt-5.6-terra"
  },
  {
    id: "deep",
    reasoningEffort: "max",
    reasoningMode: "pro",
    targetTemplateKey: "openai:gpt-5.6-sol"
  }
] as const satisfies readonly Readonly<{
  id: RunProfileId;
  reasoningEffort: string;
  reasoningMode: string;
  targetTemplateKey: string;
}>[];

export function isRunProfileId(value: unknown): value is RunProfileId {
  return typeof value === "string" && RUN_PROFILE_IDS.includes(value as RunProfileId);
}

export function runProfileMetadata(id: RunProfileId): RunProfileMetadata {
  const metadata = RUN_PROFILE_METADATA.find((profile) => profile.id === id);
  if (!metadata) {
    throw new Error("run_profile_id_invalid");
  }
  return metadata;
}

export function readableRunProfileControlValue(value: string): string {
  if (value === "max") {
    return "Maximum";
  }
  return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}
