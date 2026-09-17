/** Installation policy. The run copies this policy at admission. */
export const AGENT_POLICY_LIMITS = {
  timeoutSeconds: { defaultValue: 3600, min: 1, max: 7200 },
  maxModelCalls: { defaultValue: 40, min: 1, max: 200 },
  maxToolCalls: { defaultValue: 80, min: 1, max: 200 },
  tokenBudget: { defaultValue: 2_000_000, min: 1, max: 20_000_000 },
  maxOutputTokens: { defaultValue: 16_384, min: 1, max: 131_072 }
} as const;

export type AgentPolicyValues = Readonly<{
  limitsEnabled: boolean;
  timeoutSeconds: number;
  maxModelCalls: number;
  maxToolCalls: number;
  tokenBudget: number;
  maxOutputTokens: number;
}>;

export type AgentPolicyWire = AgentPolicyValues & Readonly<{ version: number }>;

export const DEFAULT_AGENT_POLICY: AgentPolicyWire = {
  limitsEnabled: false, version: 1,
  timeoutSeconds: 3600, maxModelCalls: 40, maxToolCalls: 80,
  tokenBudget: 2_000_000, maxOutputTokens: 16_384
};

export function decodeAgentPolicy(value: unknown): AgentPolicyWire | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 7 || typeof v.limitsEnabled !== "boolean" ||
    !Number.isSafeInteger(v.version) || Number(v.version) < 1) return null;
  for (const [key, range] of Object.entries(AGENT_POLICY_LIMITS)) {
    const n = v[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < range.min || n > range.max) return null;
  }
  return v as AgentPolicyWire;
}
