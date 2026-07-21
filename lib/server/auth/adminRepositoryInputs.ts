import type { AdminAccessRuleKind } from "@/lib/contracts/admin";
import {
  isPlausibleEmail,
  normalizeAuthDomain,
  normalizeAuthEmail
} from "@/lib/server/auth/password";

export type AdminProvisioningGroupInput = Readonly<{
  groupId: string;
  role: "member";
}>;

export function adminProvisioningGroupInputs(groupIds: readonly string[] | undefined): AdminProvisioningGroupInput[] {
  return [...new Set(groupIds ?? [])].map((groupId) => ({
    groupId,
    role: "member"
  }));
}

export function normalizeAdminRuleValue(kind: AdminAccessRuleKind, value: string): string | null {
  if (kind === "email") {
    const normalized = normalizeAuthEmail(value);

    return isPlausibleEmail(normalized) ? normalized : null;
  }

  const normalized = normalizeAuthDomain(value);

  return /^[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}

export function normalizeAdminGroupName(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, " ");

  return normalized.length >= 2 && normalized.length <= 80 ? normalized : null;
}
