export const TOOL_OBSERVATION_POLICIES = ["off", "v1"] as const;

export type ToolObservationPolicy = (typeof TOOL_OBSERVATION_POLICIES)[number];

export function isToolObservationPolicy(value: unknown): value is ToolObservationPolicy {
  return value === "off" || value === "v1";
}
