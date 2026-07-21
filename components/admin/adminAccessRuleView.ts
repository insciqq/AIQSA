import type { AdminAccessRuleRecord } from "@/lib/contracts/admin";

export function filterAdminAccessRules(
  rules: readonly AdminAccessRuleRecord[],
  query: string
): AdminAccessRuleRecord[] {
  const normalizedQuery = query.trim().toLowerCase();

  return rules.filter((rule) => {
    const haystack = [rule.kind, rule.value, ...rule.defaultGroups.map((group) => group.name)]
      .join(" ")
      .toLowerCase();

    return !normalizedQuery || haystack.includes(normalizedQuery);
  });
}
