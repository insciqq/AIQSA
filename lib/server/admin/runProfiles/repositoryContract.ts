import type { RunProfileId } from "../../../contracts/runProfiles";
import type { RunProfileModelRecord } from "../../runProfiles/configuration";

export type StoredRunProfile = Readonly<{
  description: string;
  enabled: boolean;
  id: RunProfileId;
  providerModelId: string | null;
  reasoningEffort: string;
  reasoningMode: string;
  updatedAt: Date;
  version: number;
}>;

export type AdminRunProfileState = Readonly<{
  models: RunProfileModelRecord[];
  profiles: StoredRunProfile[];
}>;

export type RunProfileWrite = Readonly<{
  description: string;
  enabled: boolean;
  expectedVersion: number;
  id: RunProfileId;
  providerModelId: string | null;
  reasoningEffort: string;
  reasoningMode: string;
}>;

export type AdminRunProfileRepository = Readonly<{
  loadState(): Promise<AdminRunProfileState>;
  updateAll(input: {
    profiles: RunProfileWrite[];
    updatedByUserId: string;
  }): Promise<"invalid_target" | "stale" | AdminRunProfileState>;
}>;
