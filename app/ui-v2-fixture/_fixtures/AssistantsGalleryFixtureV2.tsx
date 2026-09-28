"use client";

import type {
  AssistantDeleteDialogView,
  AssistantDetailSheetView,
  AssistantGalleryQuery,
  AssistantGalleryView,
  AssistantResourceNames,
  LibraryNotice
} from "@/components/assistants/libraryViewContracts";
import { AssistantDeleteDialogV2 } from "@/features/library-v2/assistants/gallery/AssistantDeleteDialogV2";
import { AssistantDetailSheetV2 } from "@/features/library-v2/assistants/gallery/AssistantDetailSheetV2";
import { AssistantGalleryV2 } from "@/features/library-v2/assistants/gallery/AssistantGalleryV2";
import { LibraryV2 } from "@/features/library-v2/LibraryV2";
import {
  type AssistantAvatarRecipe,
  type AssistantContent,
  type AssistantDetail,
  type AssistantRows,
  type AssistantSummary
} from "@/lib/contracts/assistants";
import type { AssistantDeletionConsequences } from "@/lib/contracts/assistantDeletion";
import { useState } from "react";

/** A read-only gallery view over `assistants`; `onEdit` stands for any owner action. */
export function fixtureGalleryView(assistants: readonly AssistantSummary[], onEdit: () => void): AssistantGalleryView {
  return {
    assistants: [...assistants],
    onArchiveToggle: onEdit,
    onCopyLink: async () => true,
    onDelete: onEdit,
    onDuplicate: () => undefined,
    onEdit,
    onOpenDetail: () => undefined,
    onPinToggle: () => undefined,
    onShare: onEdit,
    onStartChat: async () => false,
    recentAssistantIds: [],
    viewer: { canPublishInstallation: false, defaultAssistantId: null }
  };
}

/** Gallery, detail sheet and delete dialog states of `?fixture=assistants`. */
export const ASSISTANT_GALLERY_FIXTURE_STATES = [
  "delete-dialog",
  "delete-loading",
  "detail-consumer",
  "detail-instructions",
  "detail-owner",
  "empty",
  "empty-search",
  "error",
  "list",
  "list-archived",
  "list-filtered",
  "loading"
] as const;

export type AssistantGalleryFixtureState = (typeof ASSISTANT_GALLERY_FIXTURE_STATES)[number];

function avatar(paletteId: AssistantAvatarRecipe["paletteId"], foregroundShape: AssistantAvatarRecipe["foregroundShape"]): AssistantAvatarRecipe {
  return {
    accents: [0, 4],
    backgroundShape: "circle",
    foregroundShape,
    kind: "generated",
    paletteId,
    recipeVersion: 1,
    rotations: [0, 2]
  };
}

function summary(overrides: Partial<AssistantSummary> & Pick<AssistantSummary, "id" | "name">): AssistantSummary {
  return {
    archived: false,
    // Owner cards read their audience; a consumer's list entry has none.
    audience: overrides.owned === false ? null : { everyone: false, groupNames: [] },
    availability: { ok: true },
    avatar: avatar("ocean", "diamond"),
    category: null,
    description: "",
    featured: false,
    featuredOrder: null,
    fingerprint: {
      knowledgeLabel: null,
      knowledgeResourceCount: 0,
      mcpServerCount: 0,
      modelLabel: null,
      reasoningEffort: null,
      searchOptionCount: 0
    },
    owned: true,
    ownerDisplayName: "You",
    pinned: false,
    published: false,
    rowAvailability: {},
    scope: { kind: "owner" },
    skillLinkCount: 0,
    starterPrompts: [],
    updatedAt: "2026-09-20T10:00:00.000Z",
    ...overrides
  };
}

function fingerprint(overrides: Partial<AssistantSummary["fingerprint"]>): AssistantSummary["fingerprint"] {
  return {
    knowledgeLabel: null,
    knowledgeResourceCount: 0,
    mcpServerCount: 0,
    modelLabel: null,
    reasoningEffort: null,
    searchOptionCount: 0,
    ...overrides
  };
}

const LONG_NAME = "Quarterly procurement and vendor contract renewal reviewer for the regional finance office";

export const ASSISTANT_FIXTURE_SUMMARIES: readonly AssistantSummary[] = [
  summary({
    audience: { everyone: true, groupNames: ["Support team"] },
    avatar: avatar("meadow", "ring"),
    category: "support",
    description: "Answers questions about policies, benefits and time off from the HR handbook. Never searches the web.",
    featured: true,
    featuredOrder: 0,
    fingerprint: fingerprint({ knowledgeResourceCount: 2, modelLabel: "Gemini 3.8 Flash" }),
    id: "hr-helper",
    name: "HR Helper",
    pinned: true,
    published: true,
    skillLinkCount: 1,
    starterPrompts: ["How many vacation days do I have left?", "Explain the parental leave policy", "What is covered by the health plan?"],
    updatedAt: "2026-09-24T09:00:00.000Z"
  }),
  summary({
    avatar: avatar("ocean", "diamond"),
    category: "coding",
    description: "Reviews diffs like a senior engineer: names the file and line, explains the failure, proposes the smallest fix.",
    featured: true,
    featuredOrder: 1,
    id: "code-reviewer",
    name: "Code reviewer",
    owned: false,
    ownerDisplayName: "Ada Analyst",
    scope: { kind: "installation" },
    skillLinkCount: 2,
    updatedAt: "2026-09-22T09:00:00.000Z"
  }),
  summary({
    audience: { everyone: true, groupNames: [] },
    avatar: avatar("pine", "circle"),
    category: "productivity",
    description: "Turns raw notes into decisions, owners and dates. Keeps the original wording for quotes.",
    featured: true,
    featuredOrder: 2,
    id: "meeting-notes",
    name: "Meeting notes",
    published: true,
    updatedAt: "2026-09-18T09:00:00.000Z"
  }),
  summary({
    avatar: avatar("plum", "triangle"),
    category: "research",
    description: "Compares sources, states confidence and cites everything. Web search stays on for this one.",
    fingerprint: fingerprint({ knowledgeResourceCount: 1, searchOptionCount: 1 }),
    id: "research-analyst",
    name: "Research analyst",
    pinned: true,
    updatedAt: "2026-09-21T09:00:00.000Z"
  }),
  summary({
    audience: { everyone: false, groupNames: ["Platform team"] },
    availability: { dependencies: [{ kind: "mcp", name: "Jira" }], ok: false, reason: "tools_access" },
    avatar: avatar("sand", "hexagon"),
    category: "productivity",
    description: "Creates, searches and summarizes Jira issues for the platform team.",
    fingerprint: fingerprint({ mcpServerCount: 2, modelLabel: "Gemini 3.8 Flash" }),
    id: "jira-desk",
    name: "Jira desk",
    pinned: true,
    published: true,
    updatedAt: "2026-09-19T09:00:00.000Z"
  }),
  summary({
    avatar: avatar("coral", "square"),
    category: "writing",
    description: "Edits for clarity and tone. Shows the changed lines, then a one-paragraph summary of what changed.",
    fingerprint: fingerprint({ modelLabel: "Claude Sonnet 5" }),
    id: "writing-editor",
    name: "Writing editor",
    owned: false,
    ownerDisplayName: "Camila Collaborator",
    pinned: true,
    scope: { groupNames: ["Editorial", "Marketing"], kind: "group" },
    skillLinkCount: 1,
    updatedAt: "2026-09-17T09:00:00.000Z"
  }),
  summary({
    audience: { everyone: false, groupNames: ["Editorial", "Localization"] },
    avatar: avatar("slate", "ring"),
    category: "writing",
    description: "Translates between Russian and English while keeping meaning, numbers and names intact.",
    id: "translator",
    name: "Translator",
    published: true,
    updatedAt: "2026-09-23T09:00:00.000Z"
  }),
  summary({
    availability: { ok: false, reason: "tools_access" },
    avatar: avatar("ocean", "circle"),
    category: "analysis",
    description: "Drafts account briefs from CRM notes and the pricing base.",
    fingerprint: fingerprint({ knowledgeResourceCount: 2, mcpServerCount: 1, modelLabel: "Gemini 3.8 Flash" }),
    id: "sales-brief",
    name: "Sales brief",
    owned: false,
    ownerDisplayName: "Ada Analyst",
    scope: { groupNames: ["Sales group"], kind: "group" },
    starterPrompts: ["Brief me on Northwind before the renewal call", "Which deals changed stage this week?"],
    updatedAt: "2026-09-16T09:00:00.000Z"
  }),
  summary({
    availability: {
      dependencies: [{ kind: "mcp", name: "GitHub" }, { kind: "mcp", name: "GitLab" }, { kind: "mcp", name: "Kubernetes" }],
      ok: false,
      reason: "tools_access"
    },
    audience: { everyone: false, groupNames: ["Platform team", "Release managers", "SRE"] },
    avatar: avatar("ember", "diamond"),
    category: "coding",
    description: "Checks repositories and prepares a release checklist.",
    fingerprint: fingerprint({ mcpServerCount: 3, modelLabel: "GPT-5.6 Terra" }),
    id: "release-helper",
    name: "Release helper",
    published: true,
    updatedAt: "2026-09-15T09:00:00.000Z"
  }),
  summary({
    audience: { everyone: true, groupNames: ["Finance", "Legal", "Procurement", "Regional office"] },
    avatar: avatar("sand", "square"),
    category: "analysis",
    description: "Reads every renewal in the queue, compares it with the framework agreement, flags price increases above the indexation cap, missing service levels and auto-renewal clauses, and drafts a short memo for the category manager with the clauses quoted verbatim.",
    fingerprint: fingerprint({ knowledgeResourceCount: 12, mcpServerCount: 4, modelLabel: "Claude Sonnet 5", searchOptionCount: 2 }),
    id: "procurement-reviewer",
    name: LONG_NAME,
    published: true,
    skillLinkCount: 9,
    updatedAt: "2026-09-14T09:00:00.000Z"
  }),
  summary({
    archived: true,
    availability: { ok: false, reason: "archived" },
    avatar: avatar("slate", "triangle"),
    category: "learning",
    description: "Walked new hires through the first week. Replaced by HR Helper.",
    id: "onboarding-guide",
    name: "Onboarding guide",
    updatedAt: "2026-08-02T09:00:00.000Z"
  })
];

const names: AssistantResourceNames = {
  knowledgeBases: [{ id: "base-hr", name: "HR handbook" }, { id: "base-pricing", name: "Pricing base" }],
  knowledgeSources: [{ id: "source-benefits", name: "Benefits FAQ" }],
  mcpServers: [{ id: "mcp-jira", name: "Jira" }, { id: "mcp-confluence", name: "Confluence" }],
  models: [{ id: "model-flash", label: "Gemini 3.8 Flash" }],
  searchOptions: [{ id: "web", label: "Web Search" }]
};

const HR_INSTRUCTIONS = `You are the HR Helper for Bearstars. Answer only from the handbook and the benefits FAQ; if they do not cover a question, say so and name the HR contact.

Today is {local_date}. Quote the policy section you rely on.`;

function baseContent(assistant: AssistantSummary, rows: AssistantRows, overrides: Partial<AssistantContent> = {}): AssistantContent {
  return {
    answerRules: null,
    avatar: assistant.avatar,
    category: assistant.category,
    description: assistant.description,
    knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    mcpServerIds: [],
    name: assistant.name,
    providerModelId: null,
    responseReminder: "",
    rows,
    runControls: {},
    searchPlan: { mode: "model_choice", optionIds: [] },
    skillIds: [],
    starterPrompts: assistant.starterPrompts,
    systemPrompt: `You are ${assistant.name}. ${assistant.description}`,
    ...overrides
  };
}

/** A new Assistant's rows: every row adjustable over the viewer's own defaults. */
function plainRows(): AssistantRows {
  return {
    controls: { policy: "adjustable", value: {} },
    knowledge: { policy: "adjustable", value: { mode: "none" } },
    model: { policy: "adjustable", value: { mode: "inherit" } },
    search: { policy: "adjustable", value: { mode: "inherit" } },
    skills: { policy: "adjustable", value: { links: [], mode: "auto" } },
    tools: { policy: "adjustable", value: { mode: "inherit" } }
  };
}

function detailFor(assistant: AssistantSummary): AssistantDetail {
  const base: AssistantDetail = {
    archived: assistant.archived,
    audience: assistant.audience,
    availability: assistant.availability,
    content: baseContent(assistant, plainRows()),
    featured: assistant.featured,
    id: assistant.id,
    owned: assistant.owned,
    ownerDisplayName: assistant.ownerDisplayName,
    pinned: assistant.pinned,
    rowAvailability: assistant.rowAvailability,
    scope: assistant.scope,
    updatedAt: assistant.updatedAt,
    ...(assistant.owned
      ? {
          featuredOrder: assistant.featuredOrder,
          listingRequest: { canRequest: true, canWithdraw: false, listed: assistant.featured, request: null },
          projects: { otherProjectCount: 0, projects: [] },
          publications: [],
          recentChatCount: 3,
          version: 2
        }
      : {})
  };
  if (assistant.id === "hr-helper") {
    return {
      ...base,
      content: baseContent(assistant, {
        controls: { policy: "adjustable", value: { reasoningEffort: "medium", temperature: 0.4 } },
        knowledge: { policy: "fixed", value: { baseIds: ["base-hr"], mode: "explicit", sourceIds: ["source-benefits"] } },
        model: { policy: "adjustable", value: { mode: "model", modelId: "model-flash" } },
        search: { policy: "fixed", value: { mode: "off" } },
        skills: { policy: "adjustable", value: { links: [{ delivery: "always", skillId: "skill-citations" }], mode: "auto" } },
        tools: { policy: "fixed", value: { mode: "off" } }
      }, {
        answerRules: "Answer in short paragraphs. End with the policy section you used.",
        responseReminder: "Never give legal advice.",
        systemPrompt: HR_INSTRUCTIONS
      }),
      featuredOrder: 0,
      listingRequest: {
        canRequest: false,
        canWithdraw: false,
        listed: true,
        request: null
      },
      projects: { otherProjectCount: 1, projects: [{ id: "project-people", name: "People Ops" }] },
      publications: [
        { groupId: null, groupName: null, id: "publication-everyone", scope: "installation", updatedAt: "2026-09-10T09:00:00.000Z" },
        { groupId: "group-support", groupName: "Support team", id: "publication-support", scope: "group", updatedAt: "2026-09-10T09:00:00.000Z" }
      ],
      recentChatCount: 38,
      skills: [{ id: "skill-citations", mode: "pinned", name: "Policy citations" }],
      version: 4
    };
  }
  if (assistant.id === "sales-brief") {
    // A consumer's projection: hidden resources are counted, never named.
    return {
      ...base,
      content: baseContent(assistant, {
        controls: { policy: "fixed", value: { reasoningEffort: "low" } },
        knowledge: { policy: "fixed", value: { baseIds: ["base-pricing"], hiddenCount: 1, mode: "explicit", sourceIds: [] } },
        model: { policy: "adjustable", value: { mode: "model", modelId: null } },
        search: { policy: "adjustable", value: { mode: "inherit" } },
        skills: { policy: "adjustable", value: { hiddenCount: 1, links: [], mode: "auto" } },
        tools: { policy: "fixed", value: { hiddenCount: 1, mode: "exact", serverIds: [] } }
      }, {
        responseReminder: "Keep it under 200 words.",
        systemPrompt: "You prepare account briefs for the sales team.\nUse the CRM notes first, then the pricing base."
      }),
      rowAvailability: { model: { reason: "model_access" } }
    };
  }
  return base;
}

const hrConsequences: AssistantDeletionConsequences = {
  audiences: { groupNames: ["Support team"], installation: true },
  chatCount: 38,
  hiddenProjectCount: 1,
  pendingListingRequest: false,
  projects: [{ isDefault: true, name: "People Ops" }],
  version: 4
};

const initialQueries: Partial<Record<AssistantGalleryFixtureState, Partial<AssistantGalleryQuery>>> = {
  "empty-search": { search: "quantum" },
  "list-archived": { filter: "archived" },
  "list-filtered": { filter: "pinned", search: "the" }
};

const initialDetails: Partial<Record<AssistantGalleryFixtureState, string>> = {
  "detail-consumer": "sales-brief",
  "detail-instructions": "hr-helper",
  "detail-owner": "hr-helper"
};

export function AssistantsGalleryFixtureV2({ onClose, onFromCurrentChat, onNewAssistant, onStartChat, state }: Readonly<{
  onClose(): void;
  onFromCurrentChat?(): void;
  /** The editor fixture's New assistant sheet, when it is part of the page. */
  onNewAssistant?(): void;
  onStartChat(name: string): void;
  state: AssistantGalleryFixtureState;
}>) {
  const [list, setList] = useState<readonly AssistantSummary[]>(state === "empty" ? [] : ASSISTANT_FIXTURE_SUMMARIES);
  const [detailId, setDetailId] = useState<string | null>(initialDetails[state] ?? null);
  const [deletion, setDeletion] = useState<{ assistantId: string; state: AssistantDeleteDialogView["state"] } | null>(
    state === "delete-dialog" ? { assistantId: "hr-helper", state: "ready" }
      : state === "delete-loading" ? { assistantId: "hr-helper", state: "loading" }
        : null
  );
  const [notice, setNotice] = useState<LibraryNotice | null>(null);
  const loadState = state === "loading" ? "loading" : state === "error" ? "error" : "ready";
  const find = (id: string) => list.find((assistant) => assistant.id === id) ?? null;
  const patch = (id: string, update: Partial<AssistantSummary>) =>
    setList((current) => current.map((assistant) => assistant.id === id ? { ...assistant, ...update } : assistant));

  const gallery: AssistantGalleryView = {
    assistants: loadState === "ready" ? [...list] : [],
    onArchiveToggle(id, archived) {
      const name = find(id)?.name ?? "";
      patch(id, { archived, availability: archived ? { ok: false, reason: "archived" } : { ok: true } });
      setNotice({
        kind: "success",
        text: archived
          ? `Archived ${name}. People it is shared with can't start new chats with it; past chats keep their answers. Restore it any time.`
          : `Restored ${name}.`
      });
    },
    onCopyLink: async () => true,
    onDelete(id) {
      setDeletion({ assistantId: id, state: "ready" });
    },
    onDuplicate(id) {
      setNotice({ kind: "success", text: `Duplicated as ${find(id)?.name ?? "the Assistant"}. The copy is private.` });
    },
    onEdit(id) {
      setNotice({ kind: "success", text: `The editor for ${find(id)?.name ?? "the Assistant"} would open here.` });
    },
    onOpenDetail: setDetailId,
    onPinToggle(id, pinned) {
      patch(id, { pinned });
    },
    onShare(id) {
      setNotice({ kind: "success", text: `Sharing for ${find(id)?.name ?? "the Assistant"} would open here.` });
    },
    async onStartChat(id) {
      onStartChat(find(id)?.name ?? "the Assistant");
      return true;
    },
    recentAssistantIds: [],
    viewer: { canPublishInstallation: false, defaultAssistantId: null }
  };

  const detailSummary = detailId ? find(detailId) : null;
  const sheet: AssistantDetailSheetView | null = detailId
    ? {
        assistantId: detailId,
        detail: detailSummary ? detailFor(detailSummary) : null,
        error: null,
        names,
        onClose: () => setDetailId(null),
        onRetry: () => undefined,
        state: detailSummary ? "ready" : "unavailable",
        summary: detailSummary
      }
    : null;

  const deletionTarget = deletion ? find(deletion.assistantId) : null;
  const deleteView: AssistantDeleteDialogView | null = deletion && deletionTarget
    ? {
        assistantId: deletion.assistantId,
        consequences: deletion.state === "loading"
          ? null
          : deletion.assistantId === "hr-helper"
            ? hrConsequences
            : { ...hrConsequences, audiences: { groupNames: [], installation: false }, chatCount: 0, hiddenProjectCount: 0, projects: [] },
        error: null,
        name: deletionTarget.name,
        onCancel: () => setDeletion(null),
        onConfirm() {
          setList((current) => current.filter((assistant) => assistant.id !== deletion.assistantId));
          if (detailId === deletion.assistantId) setDetailId(null);
          setDeletion(null);
          setNotice({ kind: "success", text: `Deleted ${deletionTarget.name}.` });
        },
        onRetry: () => undefined,
        state: deletion.state
      }
    : null;

  return (
    <>
      <LibraryV2
        initialTab="assistants"
        onBack={onClose}
        tabs={[{
          content: (
            <AssistantGalleryV2
              busy={false}
              catalogError={state === "error" ? "We could not load Assistants. Nothing was changed." : null}
              catalogState={loadState}
              gallery={gallery}
              initialQuery={initialQueries[state]}
              notice={sheet ? null : notice}
              onDismissNotice={() => setNotice(null)}
              onFromCurrentChat={onFromCurrentChat ?? (() => setNotice({ kind: "success", text: "A new Assistant from the current chat would open here." }))}
              onNewAssistant={onNewAssistant ?? (() => setNotice({ kind: "success", text: "The New assistant sheet would open here." }))}
              onRetry={() => setNotice({ kind: "success", text: "Reload requested." })}
            />
          ),
          id: "assistants",
          label: "Assistants"
        }]}
      />
      {sheet ? (
        <AssistantDetailSheetV2
          busy={false}
          gallery={gallery}
          initialPreviewOpen={state === "detail-instructions"}
          notice={notice}
          sheet={sheet}
          onDismissNotice={() => setNotice(null)}
          onStartWithStarter={(assistantId) => void gallery.onStartChat(assistantId)}
        />
      ) : null}
      {deleteView ? <AssistantDeleteDialogV2 view={deleteView} /> : null}
    </>
  );
}
