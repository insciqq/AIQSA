import {
  BarChart3,
  BookOpenText,
  Boxes,
  Home,
  Layers,
  Mail,
  Search,
  Sparkles,
  SquareTerminal,
  Users,
  Wrench,
  type LucideIcon
} from "lucide-react";

export type AdminSectionId =
  | "email"
  | "groups"
  | "mcp"
  | "overview"
  | "providers"
  | "retrieval"
  | "roles"
  | "search"
  | "usage"
  | "users"
  | "workspace";

export type AdminSectionGroupId = "models" | "people" | "platform";

export type AdminSection = Readonly<{
  Icon: LucideIcon;
  group: AdminSectionGroupId | null;
  id: AdminSectionId;
  label: string;
}>;

export const defaultAdminSection: AdminSectionId = "overview";

export const adminSectionGroups = [
  { id: "models", label: "Models" },
  { id: "people", label: "People" },
  { id: "platform", label: "Platform" }
] as const satisfies readonly Readonly<{ id: AdminSectionGroupId; label: string }>[];

export const adminSections = [
  { Icon: Home, group: null, id: "overview", label: "Overview" },
  { Icon: Boxes, group: "models", id: "providers", label: "Providers" },
  { Icon: Sparkles, group: "models", id: "roles", label: "Defaults & roles" },
  { Icon: Search, group: "models", id: "search", label: "Search" },
  { Icon: BookOpenText, group: "models", id: "retrieval", label: "Knowledge & Memory" },
  { Icon: Users, group: "people", id: "users", label: "Users" },
  { Icon: Layers, group: "people", id: "groups", label: "Groups" },
  { Icon: Wrench, group: "platform", id: "mcp", label: "MCP servers" },
  { Icon: SquareTerminal, group: "platform", id: "workspace", label: "Workspace" },
  { Icon: Mail, group: "platform", id: "email", label: "Email" },
  { Icon: BarChart3, group: "platform", id: "usage", label: "Usage" }
] as const satisfies readonly AdminSection[];

/** Section ids that existed before the Control Center redesign; links from chat and bookmarks still use them. */
const legacyAdminSections: Readonly<Record<string, AdminSectionId>> = {
  access: "groups",
  "access-rules": "users",
  invites: "users",
  knowledge: "retrieval",
  memory: "retrieval",
  safety: "users",
  "system-models": "roles"
};

const adminSectionIds = new Set<AdminSectionId>(adminSections.map((section) => section.id));

export function isAdminSectionId(value: string | null): value is AdminSectionId {
  return value !== null && adminSectionIds.has(value as AdminSectionId);
}

export function resolveAdminSectionId(value: string | null): AdminSectionId {
  if (isAdminSectionId(value)) return value;
  return (value !== null && legacyAdminSections[value]) || defaultAdminSection;
}

export function parseAdminSection(search: string): AdminSectionId {
  return resolveAdminSectionId(new URLSearchParams(search).get("section"));
}

const MAX_RESOURCE_LENGTH = 256;
const MAX_FILTER_LENGTH = 64;

function boundedQueryValue(value: string | null, maxLength: number): string | null {
  return value && value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

/** The resource opened inside a section (`?resource=<id>`), e.g. one provider page. */
export function parseAdminSectionResource(search: string): string | null {
  return boundedQueryValue(new URLSearchParams(search).get("resource"), MAX_RESOURCE_LENGTH);
}

/** The list filter selected inside a section (`?filter=<value>`), e.g. `pending` on Users. */
export function parseAdminSectionFilter(search: string): string | null {
  return boundedQueryValue(new URLSearchParams(search).get("filter"), MAX_FILTER_LENGTH);
}

/** Rewrites a legacy or unknown `section` to its current id while keeping every other URL part. */
export function normalizeAdminSectionPath(currentHref: string): string {
  const url = new URL(currentHref, "http://localhost");
  const rawSection = url.searchParams.get("section");

  if (rawSection === null || isAdminSectionId(rawSection)) {
    return `${url.pathname}${url.search}${url.hash}`;
  }

  return adminSectionPath(
    currentHref,
    resolveAdminSectionId(rawSection),
    parseAdminSectionResource(url.search),
    parseAdminSectionFilter(url.search)
  );
}

/**
 * Path for a section, optionally with one opened resource or one list filter.
 * A section change always leaves the previous resource and filter behind;
 * every other query part and the hash stay intact.
 */
export function adminSectionPath(
  currentHref: string,
  section: AdminSectionId,
  resource: string | null = null,
  filter: string | null = null
): string {
  const url = new URL(currentHref, "http://localhost");

  if (section === defaultAdminSection) {
    url.searchParams.delete("section");
  } else {
    url.searchParams.set("section", section);
  }
  if (resource) {
    url.searchParams.set("resource", resource);
  } else {
    url.searchParams.delete("resource");
  }
  if (filter) {
    url.searchParams.set("filter", filter);
  } else {
    url.searchParams.delete("filter");
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

export function adminSectionConfig(section: AdminSectionId): AdminSection {
  return (
    adminSections.find((candidate) => candidate.id === section) ??
    adminSections.find((candidate) => candidate.id === defaultAdminSection)!
  );
}
