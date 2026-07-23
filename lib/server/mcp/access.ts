import type { McpConfigurationSlot, McpSlotValue } from "@/lib/contracts/mcp";
import { hashCanonicalMcpValue, validateMcpSlotValue } from "./definitions";

export type McpGrantView = {
  canUse: boolean;
  personalSlotKeys: string[];
};

export type EffectiveMcpGrant = {
  canUse: boolean;
  personalSlotKeys: Set<string>;
};

export type EffectiveMcpSlotPlanItem = {
  authorized: boolean;
  slotKey: string;
  source: "literal" | "missing" | "personal" | "shared";
  valueVersion: number | null;
};

export function resolveEffectiveMcpGrant(input: {
  direct?: McpGrantView | null;
  groups: McpGrantView[];
}): EffectiveMcpGrant {
  return {
    canUse: Boolean(input.direct?.canUse || input.groups.some((grant) => grant.canUse)),
    personalSlotKeys: new Set(input.direct?.personalSlotKeys ?? [])
  };
}

export function resolveEffectiveMcpValues(input: {
  personalSlotKeys: Set<string>;
  personalValues: Record<string, unknown>;
  personalVersion: number;
  sharedValues: Record<string, unknown>;
  sharedVersion: number;
  slots: McpConfigurationSlot[];
}): {
  invalidSlotKeys: string[];
  missingSlotKeys: string[];
  plan: EffectiveMcpSlotPlanItem[];
  values: Record<string, McpSlotValue>;
} {
  const invalidSlotKeys: string[] = [];
  const missingSlotKeys: string[] = [];
  const plan: EffectiveMcpSlotPlanItem[] = [];
  const values: Record<string, McpSlotValue> = {};

  for (const slot of input.slots) {
    if (slot.policy.kind === "literal") {
      values[slot.slotKey] = slot.policy.value;
      plan.push({ authorized: true, slotKey: slot.slotKey, source: "literal", valueVersion: null });
      continue;
    }

    const personalAuthorized = input.personalSlotKeys.has(slot.slotKey) &&
      (slot.policy.kind === "personal" || slot.policy.allowPersonalOverride);
    const hasPersonal = Object.hasOwn(input.personalValues, slot.slotKey);
    if (personalAuthorized && hasPersonal) {
      const value = input.personalValues[slot.slotKey];
      if (validateMcpSlotValue(slot, value)) {
        values[slot.slotKey] = value;
        plan.push({
          authorized: true,
          slotKey: slot.slotKey,
          source: "personal",
          valueVersion: input.personalVersion
        });
      } else {
        invalidSlotKeys.push(slot.slotKey);
        plan.push({
          authorized: true,
          slotKey: slot.slotKey,
          source: "personal",
          valueVersion: input.personalVersion
        });
      }
      continue;
    }

    if (slot.policy.kind === "shared" && Object.hasOwn(input.sharedValues, slot.slotKey)) {
      const value = input.sharedValues[slot.slotKey];
      if (validateMcpSlotValue(slot, value)) {
        values[slot.slotKey] = value;
        plan.push({
          authorized: true,
          slotKey: slot.slotKey,
          source: "shared",
          valueVersion: input.sharedVersion
        });
      } else {
        invalidSlotKeys.push(slot.slotKey);
        plan.push({
          authorized: true,
          slotKey: slot.slotKey,
          source: "shared",
          valueVersion: input.sharedVersion
        });
      }
      continue;
    }

    missingSlotKeys.push(slot.slotKey);
    plan.push({
      authorized: personalAuthorized,
      slotKey: slot.slotKey,
      source: "missing",
      valueVersion: null
    });
  }

  return { invalidSlotKeys, missingSlotKeys, plan, values };
}

export function mcpRuntimeFingerprint(input: {
  oauthConnectionRevision: string | null;
  plan: EffectiveMcpSlotPlanItem[];
  revisionId: string;
  userId: string;
}): string {
  return hashCanonicalMcpValue({
    oauthConnectionRevision: input.oauthConnectionRevision,
    plan: [...input.plan].sort((left, right) => left.slotKey.localeCompare(right.slotKey)),
    revisionId: input.revisionId,
    userId: input.userId
  });
}
