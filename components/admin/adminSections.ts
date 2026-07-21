import {
  BarChart3,
  Boxes,
  Globe2,
  Link2,
  ShieldAlert,
  SlidersHorizontal,
  Users,
  type LucideIcon
} from "lucide-react";

export type AdminSectionId =
  | "access-rules"
  | "groups"
  | "invites"
  | "model-access"
  | "safety"
  | "usage"
  | "users";

export type AdminSectionMove = "first" | "last" | "next" | "previous";

export type AdminSection = Readonly<{
  Icon: LucideIcon;
  description: string;
  id: AdminSectionId;
  label: string;
}>;

export const defaultAdminSection: AdminSectionId = "users";

export const adminSections = [
  {
    Icon: Users,
    description: "Review accounts, approvals, memberships, and user session actions.",
    id: "users",
    label: "Users"
  },
  {
    Icon: BarChart3,
    description: "Review provider-reported token usage by group and user.",
    id: "usage",
    label: "Usage"
  },
  {
    Icon: Boxes,
    description: "Create, rename, archive, and inspect operational groups.",
    id: "groups",
    label: "Groups"
  },
  {
    Icon: SlidersHorizontal,
    description: "Toggle provider, model, and search access for active groups.",
    id: "model-access",
    label: "Model access"
  },
  {
    Icon: Link2,
    description: "Create one-off invitations and revoke open invite links.",
    id: "invites",
    label: "Invites"
  },
  {
    Icon: Globe2,
    description: "Approve exact emails or domains and assign their default groups.",
    id: "access-rules",
    label: "Access rules"
  },
  {
    Icon: ShieldAlert,
    description: "High-risk session controls live here instead of the main header.",
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
  return adminSections.find((candidate) => candidate.id === section) ?? adminSections[0];
}
