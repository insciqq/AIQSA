"use client";

import type {
  AssistantResourceNames,
  AssistantSharingDraft,
  AssistantSharingFailure,
  AssistantSharingSheetView
} from "@/components/assistants/libraryViewContracts";
import type {
  AssistantAvatarRecipe,
  AssistantContent,
  AssistantDetail,
  AssistantPublicationView,
  AssistantPublishableGroup
} from "@/lib/contracts/assistants";
import type { AssistantListingStatus } from "@/lib/contracts/assistantListing";
import { AssistantSharingSheetV2 } from "@/features/library-v2/assistants/sharing/AssistantSharingSheetV2";
import { useState } from "react";

/** Sharing sheet states under `?fixture=assistants&state=`; each renders without data. */
export const ASSISTANT_SHARING_FIXTURE_STATES = [
  "sharing-admin-everyone",
  "sharing-dirty-confirm",
  "sharing-error",
  "sharing-failure",
  "sharing-groups",
  "sharing-listed",
  "sharing-loading",
  "sharing-owner-private",
  "sharing-request-none",
  "sharing-request-outdated",
  "sharing-request-pending",
  "sharing-request-rejected"
] as const;

export type AssistantSharingFixtureState = (typeof ASSISTANT_SHARING_FIXTURE_STATES)[number];

const avatar: AssistantAvatarRecipe = {
  accents: [0, 4],
  backgroundShape: "circle",
  foregroundShape: "diamond",
  kind: "generated",
  paletteId: "ocean",
  recipeVersion: 1,
  rotations: [0, 2]
};

const groups: AssistantPublishableGroup[] = [
  { id: "group-platform", memberCount: 12, name: "Platform team" },
  { id: "group-support", memberCount: 8, name: "Support" },
  { id: "group-sales", memberCount: 9, name: "Sales" }
];

const names: AssistantResourceNames = {
  knowledgeBases: [{ id: "base-runbooks", name: "Platform runbooks" }],
  knowledgeSources: [],
  mcpServers: [{ id: "mcp-jira", name: "Jira" }, { id: "mcp-confluence", name: "Confluence" }],
  models: [{ id: "model-flash", label: "Gemini 3.8 Flash" }],
  searchOptions: [{ id: "web", label: "Web Search" }]
};

function content(): AssistantContent {
  return {
    answerRules: null,
    avatar,
    category: "productivity",
    description: "Creates, searches and summarizes Jira issues for the platform team.",
    knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    mcpServerIds: ["mcp-jira", "mcp-confluence"],
    name: "Jira desk",
    providerModelId: "model-flash",
    rows: {
      controls: { policy: "adjustable", value: { reasoningEffort: "medium" } },
      knowledge: { policy: "adjustable", value: { mode: "inherit" } },
      model: { policy: "adjustable", value: { mode: "model", modelId: "model-flash" } },
      search: { policy: "adjustable", value: { mode: "inherit" } },
      skills: { policy: "adjustable", value: { links: [{ delivery: "always", skillId: "skill-jira-format" }], mode: "auto" } },
      tools: { policy: "fixed", value: { mode: "exact", serverIds: ["mcp-jira", "mcp-confluence"] } }
    },
    runControls: { reasoningEffort: "medium" },
    searchPlan: { mode: "model_choice", optionIds: [] },
    skillIds: ["skill-jira-format"],
    starterPrompts: ["Summarize the open blockers for PLAT this week"],
    systemPrompt: "You are the Jira desk for the platform team."
  };
}

function publication(groupId: string | null): AssistantPublicationView {
  const group = groups.find((entry) => entry.id === groupId);
  return {
    groupId,
    groupName: group?.name ?? null,
    id: groupId ? `publication-${groupId}` : "publication-installation",
    scope: groupId ? "group" : "installation",
    updatedAt: "2026-09-24T09:00:00.000Z"
  };
}

const noListing: AssistantListingStatus = { canRequest: true, canWithdraw: false, listed: false, request: null };

function request(state: "approved" | "pending" | "rejected", overrides: Partial<NonNullable<AssistantListingStatus["request"]>> = {}) {
  return {
    createdAt: "2026-09-25T10:00:00.000Z",
    definitionVersion: 7,
    id: "request-1",
    outdated: false,
    reviewNote: null,
    reviewedAt: state === "pending" ? null : "2026-09-26T15:30:00.000Z",
    state,
    ...overrides
  };
}

type Scenario = {
  admin: boolean;
  draft?: Partial<AssistantSharingDraft>;
  failures?: AssistantSharingFailure[];
  featuredCount?: number;
  detail: Partial<AssistantDetail>;
  state?: "error" | "loading";
};

const scenarios: Record<AssistantSharingFixtureState, Scenario> = {
  "sharing-admin-everyone": {
    admin: true,
    detail: {
      audience: { everyone: true, groupNames: ["Platform team"] },
      featured: true,
      featuredOrder: 1,
      listingRequest: { canRequest: false, canWithdraw: false, listed: true, request: null },
      publications: [publication("group-platform"), publication(null)]
    },
    featuredCount: 2
  },
  "sharing-dirty-confirm": {
    admin: false,
    detail: { audience: { everyone: false, groupNames: ["Platform team"] }, publications: [publication("group-platform")] },
    draft: { groupIds: ["group-platform", "group-support"] }
  },
  "sharing-error": { admin: false, detail: {}, state: "error" },
  // Sales was to replace Platform team: its failure kept Platform team.
  "sharing-failure": {
    admin: false,
    detail: { audience: { everyone: false, groupNames: ["Platform team"] }, publications: [publication("group-platform")] },
    draft: { groupIds: ["group-sales"] },
    failures: [{
      code: "assistant_skill_audience_mismatch",
      skills: ["Jira issue format"],
      target: { groupId: "group-sales", kind: "group" },
      text: "Share every included Skill with this audience first, then save again."
    }]
  },
  "sharing-groups": {
    admin: false,
    detail: {
      audience: { everyone: false, groupNames: ["Platform team", "Support"] },
      publications: [publication("group-platform"), publication("group-support")]
    }
  },
  "sharing-listed": {
    admin: false,
    detail: {
      audience: { everyone: true, groupNames: [] },
      listingRequest: { canRequest: false, canWithdraw: false, listed: true, request: request("approved") },
      publications: [publication(null)]
    }
  },
  "sharing-loading": { admin: false, detail: {}, state: "loading" },
  "sharing-owner-private": { admin: false, detail: {} },
  "sharing-request-none": { admin: false, detail: {}, draft: { audience: "everyone" } },
  "sharing-request-outdated": {
    admin: false,
    detail: { listingRequest: { canRequest: true, canWithdraw: true, listed: false, request: request("pending", { outdated: true }) } }
  },
  "sharing-request-pending": {
    admin: false,
    detail: { listingRequest: { canRequest: false, canWithdraw: true, listed: false, request: request("pending") } }
  },
  "sharing-request-rejected": {
    admin: false,
    detail: {
      audience: { everyone: false, groupNames: ["Platform team"] },
      listingRequest: {
        canRequest: true,
        canWithdraw: false,
        listed: false,
        request: request("rejected", {
          reviewNote: "The instructions name an internal Confluence space. Remove it and submit again."
        })
      },
      publications: [publication("group-platform")]
    }
  }
};

function detailFor(scenario: Scenario): AssistantDetail {
  return {
    archived: false,
    audience: { everyone: false, groupNames: [] },
    availability: { ok: true },
    content: content(),
    featured: false,
    featuredOrder: null,
    id: "jira-desk",
    listingRequest: noListing,
    owned: true,
    ownerDisplayName: "Lena Ortiz",
    pinned: false,
    projects: { otherProjectCount: 1, projects: [{ id: "project-ops", name: "Platform ops" }, { id: "project-incidents", name: "Incident room" }] },
    publications: [],
    recentChatCount: 42,
    rowAvailability: {},
    scope: { kind: "owner" },
    skills: [{ id: "skill-jira-format", mode: "pinned", name: "Jira issue format" }],
    updatedAt: "2026-09-27T08:00:00.000Z",
    version: 7,
    ...scenario.detail
  };
}

function savedDraft(detail: AssistantDetail, featuredCount: number): AssistantSharingDraft {
  const groupIds = (detail.publications ?? []).flatMap((entry) => entry.scope === "group" && entry.groupId ? [entry.groupId] : []);
  const request = detail.listingRequest?.request;
  const everyone = (detail.publications ?? []).some((entry) => entry.scope === "installation") ||
    (request?.state === "pending" && !request.outdated);
  return {
    audience: everyone ? "everyone" : groupIds.length > 0 ? "groups" : "owner",
    featured: detail.featured,
    featuredOrder: detail.featuredOrder ?? featuredCount,
    groupIds
  };
}

/**
 * The Sharing sheet over the editor, driven by local state: changes, Save
 * (which closes it) and Withdraw behave as they do with the controller.
 */
export function AssistantsSharingFixtureV2({ onClose, onSaved, state }: Readonly<{
  onClose(): void;
  onSaved(): void;
  state: AssistantSharingFixtureState;
}>) {
  const scenario = scenarios[state];
  const featuredCount = scenario.featuredCount ?? 0;
  const [detail, setDetail] = useState(() => detailFor(scenario));
  const [baseline, setBaseline] = useState(() => savedDraft(detailFor(scenario), featuredCount));
  const [draft, setDraft] = useState<AssistantSharingDraft>(() => ({ ...savedDraft(detailFor(scenario), featuredCount), ...scenario.draft }));
  const [failures, setFailures] = useState<AssistantSharingFailure[]>(scenario.failures ?? []);
  const view: AssistantSharingSheetView = {
    assistantId: detail.id,
    detail: scenario.state ? null : detail,
    dirty: JSON.stringify(draft) !== JSON.stringify(baseline),
    draft,
    error: scenario.state === "error" ? "Could not load the Assistant. Check your connection and try again." : null,
    failures,
    featuredCount,
    groups,
    isAdministrator: scenario.admin,
    listing: detail.listingRequest ?? null,
    name: "Jira desk",
    names,
    onChange(update) {
      const groupsUpdate = update.audience === "everyone"
        ? { groupIds: savedDraft(detail, featuredCount).groupIds }
        : update.audience === "owner" ? { groupIds: [] } : {};
      setDraft((current) => ({ ...current, ...update, ...groupsUpdate }));
      setFailures([]);
    },
    onClose,
    onCopyLink: async () => true,
    onRetry: () => undefined,
    async onSave() {
      setBaseline(draft);
      onSaved();
      return true;
    },
    onWithdrawRequest() {
      const next = { ...detail, listingRequest: { canRequest: true, canWithdraw: false, listed: false, request: null } };
      setDetail(next);
      const clean = JSON.stringify(draft) === JSON.stringify(baseline);
      const saved = savedDraft(next, featuredCount);
      setBaseline(saved);
      if (clean) setDraft(saved);
    },
    saving: false,
    state: scenario.state ?? "ready",
    withdrawing: false
  };
  return <AssistantSharingSheetV2 initialConfirmingDiscard={state === "sharing-dirty-confirm"} view={view} />;
}
