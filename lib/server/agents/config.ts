import { DEFAULT_AGENT_POLICY, decodeAgentPolicy, type AgentPolicyWire } from "@/lib/contracts/agentPolicy";
import { CODEX_VERSION } from "./codexProfile";

/** Frozen per accepted turn; null means no Agent deadline. */
export type NormalizedRunAgent = Readonly<{
  version: 2;
  policyVersion: number;
  limitsEnabled: boolean;
  codexVersion: string;
  gatewayOrigin: string;
  maxModelCalls: number;
  maxToolCalls: number;
  maxOutputTokens: number;
  tokenBudget: number;
  timeoutSeconds: number | null;
  compatibilityHash: string;
  mcpMode: "auto" | "all" | "off";
}>;

export function agentLimits(policy: AgentPolicyWire, env: Readonly<Record<string, string | undefined>> = process.env) {
  if (!decodeAgentPolicy(policy)) throw new Error("agent_config_invalid");
  const raw = env.AIQSA_AGENT_GATEWAY_URL?.trim();
  if (!raw) throw new Error("agent_unavailable");
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash) throw new Error("agent_config_invalid");
  const { version: policyVersion, ...values } = policy;
  return {
    ...values, version: 2 as const, policyVersion, codexVersion: CODEX_VERSION,
    gatewayOrigin: url.origin, timeoutSeconds: policy.limitsEnabled ? policy.timeoutSeconds : null
  };
}

export const AGENT_GRANT_LEASE_MS = 30_000;
export const AGENT_REQUEST_MAX_BYTES = 8 * 1024 * 1024;

export function validNormalizedAgent(value: unknown): value is NormalizedRunAgent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 2 || v.codexVersion !== CODEX_VERSION || typeof v.compatibilityHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(v.compatibilityHash) || !["auto", "all", "off"].includes(String(v.mcpMode)) ||
    Object.keys(v).length !== 12 || typeof v.gatewayOrigin !== "string" ||
    (v.limitsEnabled === false && v.timeoutSeconds !== null) ||
    !Number.isSafeInteger(v.maxOutputTokens) || Number(v.maxOutputTokens) < 1) return false;
  try {
    const origin = new URL(v.gatewayOrigin);
    if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== v.gatewayOrigin) return false;
  } catch { return false; }
  return decodeAgentPolicy({ version: v.policyVersion, limitsEnabled: v.limitsEnabled,
    timeoutSeconds: v.limitsEnabled ? v.timeoutSeconds : 3600, maxModelCalls: v.maxModelCalls,
    maxToolCalls: v.maxToolCalls, tokenBudget: v.tokenBudget,
    // Off carries the admitted model's output setting, not an Agent policy cap.
    maxOutputTokens: v.limitsEnabled ? v.maxOutputTokens : DEFAULT_AGENT_POLICY.maxOutputTokens }) !== null;
}
