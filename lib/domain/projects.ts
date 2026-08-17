export const PROJECT_ROLES = [
  "VIEWER",
  "CONTRIBUTOR",
  "MANAGER",
  "OWNER"
] as const;

export type ProjectRole = (typeof PROJECT_ROLES)[number];

const roleRank = new Map<ProjectRole, number>(
  PROJECT_ROLES.map((role, index) => [role, index])
);

export function isProjectRole(value: unknown): value is ProjectRole {
  return typeof value === "string" && roleRank.has(value as ProjectRole);
}

export function projectRoleAtLeast(
  role: ProjectRole,
  minimum: ProjectRole
): boolean {
  return roleRank.get(role)! >= roleRank.get(minimum)!;
}

export function highestProjectRole(
  roles: readonly ProjectRole[]
): ProjectRole | null {
  return roles.reduce<ProjectRole | null>(
    (highest, role) =>
      highest === null || projectRoleAtLeast(role, highest) ? role : highest,
    null
  );
}

export const PROJECT_ROLE_CAPABILITIES = Object.freeze({
  VIEWER: Object.freeze({
    archiveChats: false,
    manageMembers: false,
    manageProject: false,
    manageOwners: false,
    manageMemory: false,
    mutateChats: false
  }),
  CONTRIBUTOR: Object.freeze({
    archiveChats: false,
    manageMembers: false,
    manageProject: false,
    manageOwners: false,
    manageMemory: false,
    mutateChats: true
  }),
  MANAGER: Object.freeze({
    archiveChats: true,
    manageMembers: true,
    manageProject: true,
    manageOwners: false,
    manageMemory: true,
    mutateChats: true
  }),
  OWNER: Object.freeze({
    archiveChats: true,
    manageMembers: true,
    manageProject: true,
    manageOwners: true,
    manageMemory: true,
    mutateChats: true
  })
} satisfies Record<ProjectRole, Readonly<{
  archiveChats: boolean;
  manageMembers: boolean;
  manageProject: boolean;
  manageOwners: boolean;
  manageMemory: boolean;
  mutateChats: boolean;
}>>);
