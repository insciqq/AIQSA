import type {
  AssistantResourceNames,
  AssistantSharingDraft,
  AssistantSharingFailure
} from "@/components/assistants/libraryViewContracts";
import type { UiV2IconName } from "@/components/ui-v2";
import type { AssistantDetail, AssistantPublishableGroup } from "@/lib/contracts/assistants";
import type { AssistantListingStatus } from "@/lib/contracts/assistantListing";
import { formatStudioDate } from "@/features/library-v2/studioDate";

/*
 * Copy of the Sharing sheet (PRD 10.4). Resources are named only from the
 * owner's own catalogs; anything else is counted, never identified.
 */

export type AssistantSharingAccessItem = Readonly<{
  icon: UiV2IconName;
  key: string;
  label: string;
}>;

type Kind = Readonly<{ icon: UiV2IconName; key: string; noun: readonly [string, string] }>;

function kindItems(
  kind: Kind,
  entries: readonly { id: string; label: string | undefined }[],
  hiddenCount: number
): AssistantSharingAccessItem[] {
  const named = entries.filter((entry): entry is { id: string; label: string } => entry.label !== undefined);
  const unnamed = entries.length - named.length + hiddenCount;
  const items = named.map((entry) => ({ icon: kind.icon, key: `${kind.key}:${entry.id}`, label: entry.label }));
  if (unnamed > 0) {
    const noun = unnamed === 1 ? kind.noun[0] : kind.noun[1];
    items.push({ icon: kind.icon, key: `${kind.key}:unnamed`, label: `${unnamed} ${named.length > 0 ? "more " : ""}${noun}` });
  }
  return items;
}

function lookup(catalog: readonly { id: string; name?: string; label?: string }[], ids: readonly string[]) {
  const byId = new Map(catalog.map((entry) => [entry.id, entry.name ?? entry.label]));
  return ids.map((id) => ({ id, label: byId.get(id) }));
}

/**
 * What people the Assistant is shared with need access to: the resources of
 * Fixed rows and every Skill link. Adjustable rows fall back instead.
 */
export function assistantSharingAccessItems(
  detail: AssistantDetail,
  names: AssistantResourceNames
): AssistantSharingAccessItem[] {
  const { rows } = detail.content;
  const items: AssistantSharingAccessItem[] = [];
  const model = rows.model;
  if (model.policy === "fixed" && model.value.mode === "model") {
    const modelId = model.value.modelId;
    items.push(...kindItems(
      { icon: "layers", key: "model", noun: ["model", "models"] },
      [{ id: modelId ?? "model", label: modelId ? names.models.find((entry) => entry.id === modelId)?.label : undefined }],
      0
    ));
  }
  const search = rows.search;
  if (search.policy === "fixed" && search.value.mode !== "inherit" && search.value.mode !== "off") {
    items.push(...kindItems(
      { icon: "globe", key: "search", noun: ["Search source", "Search sources"] },
      lookup(names.searchOptions, search.value.optionIds),
      search.value.hiddenCount ?? 0
    ));
  }
  const tools = rows.tools;
  if (tools.policy === "fixed" && tools.value.mode === "exact") {
    items.push(...kindItems(
      { icon: "plug", key: "tools", noun: ["MCP server", "MCP servers"] },
      lookup(names.mcpServers, tools.value.serverIds),
      tools.value.hiddenCount ?? 0
    ));
  }
  const knowledge = rows.knowledge;
  if (knowledge.policy === "fixed" && knowledge.value.mode === "explicit") {
    items.push(...kindItems(
      { icon: "book", key: "knowledge", noun: ["Knowledge base or document", "Knowledge bases or documents"] },
      [...lookup(names.knowledgeBases, knowledge.value.baseIds), ...lookup(names.knowledgeSources, knowledge.value.sourceIds)],
      knowledge.value.hiddenCount ?? 0
    ));
  }
  const skills = rows.skills.value;
  const skillNames = new Map((detail.skills ?? []).map((skill) => [skill.id, skill.name]));
  items.push(...kindItems(
    { icon: "wand", key: "skills", noun: ["Skill", "Skills"] },
    skills.links.map((link) => {
      const name = skillNames.get(link.skillId);
      return { id: link.skillId, label: name === undefined ? undefined : `Skill “${name}”` };
    }),
    skills.hiddenCount ?? 0
  ));
  return items;
}

/** The owner's active groups and any group the Assistant is still published to. */
export function assistantSharingGroups(
  groups: readonly AssistantPublishableGroup[],
  detail: AssistantDetail | null
): { id: string; memberCount: number | null; name: string }[] {
  const listed = groups.map((group) => ({ id: group.id, memberCount: group.memberCount as number | null, name: group.name }));
  for (const publication of detail?.publications ?? []) {
    if (publication.scope !== "group" || !publication.groupId) continue;
    if (listed.some((group) => group.id === publication.groupId)) continue;
    listed.push({ id: publication.groupId, memberCount: null, name: publication.groupName ?? "Group" });
  }
  return listed;
}

export function memberCountText(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

export type AssistantListingStatusCopy = Readonly<{
  label: "Approved" | "Outdated" | "Pending" | "Rejected";
  note: string | null;
  /** A new request can be sent: choosing the option and saving sends it. */
  resend: boolean;
  text: string;
  tone: "neutral" | "ok" | "warn";
}>;

/** How the owner sends a request again, in the sheet's own terms. */
export const LISTING_RESEND_TEXT = "Choose this option and save to send it again.";

/** The non-administrator's listing request as the server reports it; nothing for withdrawn or superseded. */
export function assistantListingStatusCopy(listing: AssistantListingStatus | null): AssistantListingStatusCopy | null {
  if (!listing) return null;
  const request = listing.request;
  if (listing.listed) {
    return {
      label: "Approved",
      note: null,
      resend: false,
      text: request?.state === "approved" && request.reviewedAt
        ? `Listed for everyone since ${formatStudioDate(request.reviewedAt)}.`
        : "Listed for everyone.",
      tone: "ok"
    };
  }
  if (!request) return null;
  if (request.state === "pending") {
    return request.outdated
      ? {
          label: "Outdated",
          note: null,
          resend: listing.canRequest,
          text: "Your Assistant changed since the request.",
          tone: "warn"
        }
      : { label: "Pending", note: null, resend: false, text: `Sent ${formatStudioDate(request.createdAt)}.`, tone: "neutral" };
  }
  if (request.state === "rejected") {
    return {
      label: "Rejected",
      note: request.reviewNote,
      resend: listing.canRequest,
      text: request.reviewedAt ? `Reviewed ${formatStudioDate(request.reviewedAt)}.` : "An administrator declined it.",
      tone: "warn"
    };
  }
  return null;
}

/**
 * What Save takes away, named before it happens: the listing for everyone,
 * a pending request, Featured and the groups that lose it.
 */
export function assistantSharingConsequences(
  detail: AssistantDetail,
  draft: AssistantSharingDraft,
  groupNames: ReadonlyMap<string, string>
): string[] {
  const lines: string[] = [];
  const publications = detail.publications ?? [];
  if (draft.audience !== "everyone") {
    if (publications.some((publication) => publication.scope === "installation")) {
      lines.push(detail.featured
        ? "Saving removes it from everyone in this installation and from Featured."
        : "Saving removes it from everyone in this installation.");
    }
    const request = detail.listingRequest?.request;
    if (request?.state === "pending" && !request.outdated) {
      lines.push("Saving withdraws your request to list it for everyone.");
    }
  }
  const kept = new Set(draft.audience === "groups" ? draft.groupIds : draft.audience === "everyone"
    ? publications.flatMap((publication) => publication.scope === "group" && publication.groupId ? [publication.groupId] : [])
    : []);
  const revoked = publications.flatMap((publication) =>
    publication.scope === "group" && publication.groupId && !kept.has(publication.groupId)
      ? [groupNames.get(publication.groupId) ?? publication.groupName ?? "a group"]
      : []);
  if (revoked.length > 0) lines.push(`Saving stops sharing it with ${revoked.join(", ")}.`);
  return lines;
}

/**
 * Whether a failure of the last Save gave access or sent a request; after
 * such a failure Save takes nothing away. While failures show, the draft is
 * the one that was saved: any change clears them.
 */
export function sharingFailureGives(failure: AssistantSharingFailure, draft: AssistantSharingDraft): boolean {
  const target = failure.target;
  if (target.kind === "group") return draft.audience === "groups" && draft.groupIds.includes(target.groupId);
  return target.kind === "everyone" ? draft.audience === "everyone" : draft.featured;
}

/**
 * The failure's copy. Skills that do not reach the audience are named with
 * the audience: a group's name, or "everyone".
 */
export function assistantSharingFailureText(failure: AssistantSharingFailure, audience: string): string {
  const [first, ...rest] = failure.skills;
  if (first === undefined) return failure.text;
  if (rest.length === 0) return `Share the Skill “${first}” with ${audience} first, then save again.`;
  const names = failure.skills.map((name) => `“${name}”`).join(", ");
  return `Share these Skills with ${audience} first, then save again: ${names}.`;
}
