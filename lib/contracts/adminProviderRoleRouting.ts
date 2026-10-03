/** Installation roles that pin one answer deployment and stop when it cannot serve them. */
export type AdminProviderAssignedRole = "memory" | "system_model" | "chat_titles" | "vision" | "chat_pdf" | "chat_pdf_native";

export const ADMIN_PROVIDER_ASSIGNED_ROLES: readonly AdminProviderAssignedRole[] = [
  "memory", "system_model", "chat_titles", "vision", "chat_pdf", "chat_pdf_native"
];

/** A role the selected OpenRouter providers cannot serve, with the request
 * parameters none of them list (OpenRouter catalog names). An empty list means
 * the catalog could not confirm the role either way. */
export type AdminProviderRoleRoutingConflict = Readonly<{
  role: AdminProviderAssignedRole;
  missingParameters: readonly string[];
}>;

const PARAMETER = /^[a-z][a-z0-9_]{0,63}$/u;

export function decodeAdminProviderAssignedRoles(value: unknown): AdminProviderAssignedRole[] | null {
  if (!Array.isArray(value) || value.length > ADMIN_PROVIDER_ASSIGNED_ROLES.length ||
    !value.every((role) => ADMIN_PROVIDER_ASSIGNED_ROLES.includes(role as AdminProviderAssignedRole)) ||
    new Set(value).size !== value.length) return null;
  return value as AdminProviderAssignedRole[];
}

export function decodeAdminProviderRoleRoutingConflicts(value: unknown): AdminProviderRoleRoutingConflict[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > ADMIN_PROVIDER_ASSIGNED_ROLES.length) return null;
  const conflicts: AdminProviderRoleRoutingConflict[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    if (!ADMIN_PROVIDER_ASSIGNED_ROLES.includes(row.role as AdminProviderAssignedRole) ||
      conflicts.some(({ role }) => role === row.role) || !Array.isArray(row.missingParameters) ||
      row.missingParameters.length > 8 ||
      !row.missingParameters.every((parameter) => typeof parameter === "string" && PARAMETER.test(parameter))) return null;
    conflicts.push({ role: row.role as AdminProviderAssignedRole, missingParameters: [...row.missingParameters as string[]] });
  }
  return conflicts;
}
