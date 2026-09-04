import {
  BarChart3,
  BookOpenText,
  Boxes,
  BrainCircuit,
  Globe2,
  Link2,
  Mail,
  Search,
  ServerCog,
  ShieldAlert,
  SquareTerminal,
  Users,
  Wrench,
  type LucideIcon
} from "lucide-react";

export type AdminSectionId =
  | "access-rules"
  | "access"
  | "email"
  | "invites"
  | "knowledge"
  | "memory"
  | "mcp"
  | "providers"
  | "search"
  | "safety"
  | "usage"
  | "users"
  | "workspace";

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
    description: "Connect providers and manage models, credentials, access, and defaults.",
    group: "ai-setup",
    id: "providers",
    label: "Providers"
  },
  {
    Icon: Search,
    description: "Add, test, activate, publish, and inspect replaceable Search engines.",
    group: "ai-setup",
    id: "search",
    label: "Search"
  },
  {
    Icon: BookOpenText,
    description: "Choose the installation embedding route and inspect fixed retrieval limits without exposing private bases.",
    group: "ai-setup",
    id: "knowledge",
    label: "Knowledge"
  },
  {
    Icon: BrainCircuit,
    description: "Check configured Memory models, worker, queue, index readiness, and bounded rebuild.",
    group: "ai-setup",
    id: "memory",
    label: "Memory"
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
    Icon: SquareTerminal,
    description: "Control isolated per-chat workspaces, public network policy, and runtime readiness.",
    group: "infrastructure",
    id: "workspace",
    label: "Workspace"
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

export function isAdminSectionId(value: string | null): value is AdminSectionId {
  return value !== null && adminSectionIds.has(value as AdminSectionId);
}

export function parseAdminSection(search: string): AdminSectionId {
  const section = new URLSearchParams(search).get("section");
  return isAdminSectionId(section) ? section : defaultAdminSection;
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
