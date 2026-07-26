import {
  BarChart3,
  Boxes,
  Globe2,
  Link2,
  Mail,
  ServerCog,
  ShieldAlert,
  Users,
  Wrench,
  type LucideIcon
} from "lucide-react";

export type AdminSectionId =
  | "access-rules"
  | "access"
  | "email"
  | "invites"
  | "mcp"
  | "providers"
  | "safety"
  | "usage"
  | "users";

export type AdminSectionMove = "first" | "last" | "next" | "previous";
export type AdminSectionGroupId = "ai-setup" | "infrastructure" | "operations" | "safety" | "team-access";

export type AdminSection = Readonly<{
  Icon: LucideIcon;
  description: string;
  group: AdminSectionGroupId;
  id: AdminSectionId;
  label: string;
}>;

export const defaultAdminSection: AdminSectionId = "providers";

export const adminSectionGroups = [
  { id: "ai-setup", label: "AI setup" },
  { id: "team-access", label: "Team & access" },
  { id: "operations", label: "Operations" },
  { id: "infrastructure", label: "Infrastructure" },
  { id: "safety", label: "Safety" }
] as const satisfies readonly Readonly<{ id: AdminSectionGroupId; label: string }>[];

export const adminSections = [
  {
    Icon: ServerCog,
    description: "Connect a provider for your account, or open advanced team and custom configuration.",
    group: "ai-setup",
    id: "providers",
    label: "Providers"
  },
  {
    Icon: Users,
    description: "Review accounts, approvals, memberships, and user session actions.",
    group: "team-access",
    id: "users",
    label: "Users"
  },
  {
    Icon: Boxes,
    description: "Manage access groups, memberships, model and search entitlements, and MCP tools.",
    group: "team-access",
    id: "access",
    label: "Access & groups"
  },
  {
    Icon: Link2,
    description: "Create one-off invitations and revoke open invite links.",
    group: "team-access",
    id: "invites",
    label: "Invites"
  },
  {
    Icon: Globe2,
    description: "Approve exact emails or domains and assign their default groups.",
    group: "team-access",
    id: "access-rules",
    label: "Access rules"
  },
  {
    Icon: BarChart3,
    description: "Review provider-reported token usage by group and user.",
    group: "operations",
    id: "usage",
    label: "Usage"
  },
  {
    Icon: Wrench,
    description: "Install, test, activate, update, and grant trusted MCP servers.",
    group: "infrastructure",
    id: "mcp",
    label: "MCP servers"
  },
  {
    Icon: Mail,
    description: "Configure, test, activate, and monitor installation email delivery.",
    group: "infrastructure",
    id: "email",
    label: "Email delivery"
  },
  {
    Icon: ShieldAlert,
    description: "High-risk session controls live here instead of the main header.",
    group: "safety",
    id: "safety",
    label: "Safety"
  }
] as const satisfies readonly AdminSection[];

const adminSectionIds = new Set<AdminSectionId>(adminSections.map((section) => section.id));
const legacyAdminSectionAliases = new Map<string, AdminSectionId>([
  ["groups", "access"],
  ["model-access", "access"]
]);

export function isAdminSectionId(value: string | null): value is AdminSectionId {
  return value !== null && adminSectionIds.has(value as AdminSectionId);
}

export function parseAdminSection(search: string): AdminSectionId {
  const section = new URLSearchParams(search).get("section");

  return isAdminSectionId(section)
    ? section
    : legacyAdminSectionAliases.get(section ?? "") ?? defaultAdminSection;
}

export function normalizeAdminSectionPath(currentHref: string): string {
  const url = new URL(currentHref, "http://localhost");
  const rawSection = url.searchParams.get("section");

  if (rawSection === null || isAdminSectionId(rawSection)) {
    return `${url.pathname}${url.search}${url.hash}`;
  }

  return adminSectionPath(currentHref, parseAdminSection(url.search));
}

export function adminSectionPath(currentHref: string, section: AdminSectionId): string {
  const url = new URL(currentHref, "http://localhost");

  if (section === defaultAdminSection) {
    url.searchParams.delete("section");
  } else {
    url.searchParams.set("section", section);
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

export function moveAdminSection(currentSection: AdminSectionId, direction: AdminSectionMove): AdminSectionId {
  const currentIndex = adminSections.findIndex((section) => section.id === currentSection);
  const fallbackIndex = currentIndex === -1 ? 0 : currentIndex;
  const nextIndex =
    direction === "first"
      ? 0
      : direction === "last"
        ? adminSections.length - 1
        : direction === "next"
          ? (fallbackIndex + 1) % adminSections.length
          : (fallbackIndex - 1 + adminSections.length) % adminSections.length;

  return adminSections[nextIndex]!.id;
}

export function adminSectionMoveForKey(key: string): AdminSectionMove | null {
  if (key === "ArrowRight" || key === "ArrowDown") {
    return "next";
  }

  if (key === "ArrowLeft" || key === "ArrowUp") {
    return "previous";
  }

  if (key === "Home") {
    return "first";
  }

  return key === "End" ? "last" : null;
}

export function adminSectionTabId(section: AdminSectionId): string {
  return `admin-tab-${section}`;
}

export function adminSectionPanelId(section: AdminSectionId): string {
  return `admin-panel-${section}`;
}

export function adminSectionConfig(section: AdminSectionId): AdminSection {
  return (
    adminSections.find((candidate) => candidate.id === section) ??
    adminSections.find((candidate) => candidate.id === defaultAdminSection)!
  );
}
