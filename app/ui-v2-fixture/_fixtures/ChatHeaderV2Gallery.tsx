"use client";

import type { ShellComposerAssistant } from "@/components/app-shell/powerAppShellV2Contracts";
import type { CatalogModel } from "@/components/app-shell/types";
import type { AssistantAvatarRecipe, AssistantSummary } from "@/lib/contracts/assistants";
import type { ChatNavigationSummaryWire } from "@/lib/contracts/chats";
import { AssistantPickerV2 } from "@/features/composer-v2/AssistantPickerV2";
import { ConversationV2 } from "@/features/conversation-v2/ConversationV2";
import { NavigationSidebar, ReadingRoomShellV2 } from "@/features/navigation-v2/NavigationV2";
import { AssistantBindingNoticeV2 } from "@/features/workspace-v2/AssistantBindingNoticeV2";
import { AssistantIntroV2 } from "@/features/workspace-v2/AssistantIntroV2";
import {
  HeaderAssistantSelectorV2,
  headerModelProvenanceV2,
  type HeaderAssistantSelectorActionsV2
} from "@/features/workspace-v2/HeaderAssistantSelectorV2";
import { WorkspaceHeaderV2 } from "@/features/workspace-v2/WorkspaceHeaderV2";
import { useEffect, useRef, useState } from "react";

export type ChatHeaderGalleryState =
  | "archived-consumer"
  | "archived-owner"
  | "changed"
  | "chosen"
  | "deleted"
  | "empty"
  | "fixed"
  | "menu"
  | "picker"
  | "unavailable-consumer"
  | "unavailable-owner";

function avatar(
  paletteId: AssistantAvatarRecipe["paletteId"],
  backgroundShape: AssistantAvatarRecipe["backgroundShape"],
  foregroundShape: AssistantAvatarRecipe["foregroundShape"],
  accents: number[]
): AssistantAvatarRecipe {
  return { accents, backgroundShape, foregroundShape, kind: "generated", paletteId, recipeVersion: 1, rotations: [0, 0] };
}

function summary(
  id: string,
  name: string,
  recipe: AssistantAvatarRecipe,
  overrides: Partial<AssistantSummary> = {}
): AssistantSummary {
  return {
    archived: false,
    audience: overrides.owned ? { everyone: false, groupNames: [] } : null,
    availability: { ok: true },
    avatar: recipe,
    category: null,
    description: `${name} for the chat header fixture.`,
    featured: false,
    featuredOrder: null,
    fingerprint: {
      mcpServerCount: 0,
      modelLabel: null,
      reasoningEffort: null,
      searchOptionCount: 0
    },
    id,
    name,
    owned: false,
    ownerDisplayName: "Local Operator",
    pinned: false,
    published: true,
    rowAvailability: {},
    scope: { kind: "installation" },
    skillLinkCount: 0,
    starterPrompts: [],
    updatedAt: "2026-09-27T12:00:00.000Z",
    ...overrides
  };
}

export const chatHeaderGalleryAssistants: AssistantSummary[] = [
  summary("assistant-hr", "HR Helper", avatar("meadow", "circle", "ring", [0, 4]), { owned: true, pinned: true }),
  summary("assistant-review", "Code reviewer", avatar("ocean", "square", "diamond", [2]), { featured: true, featuredOrder: 0 }),
  summary("assistant-notes", "Meeting notes", avatar("pine", "ring", "circle", [6]), { ownerDisplayName: "Dana Ivanova" }),
  summary("assistant-analyst", "Research analyst", avatar("plum", "hexagon", "triangle", [1, 5]), { owned: true }),
  summary("assistant-jira", "Jira desk", avatar("sand", "square", "hexagon", [3, 7]), {
    availability: { dependencies: [{ kind: "mcp", name: "Jira MCP" }], ok: false, reason: "tools_access" },
    owned: true
  }),
  summary("assistant-sales", "Sales brief", avatar("coral", "triangle", "circle", [1]), {
    availability: { ok: false, reason: "tools_access" },
    ownerDisplayName: "Dana Ivanova"
  })
];

export const chatHeaderGalleryRecentIds = ["assistant-notes"];

const models = [
  { displayName: "Gemini 3.8 Flash", modelId: "gemini-3.8-flash" },
  { displayName: "Claude Sonnet 5", modelId: "claude-sonnet-5" },
  { displayName: "DeepSeek V4.1 Flash", modelId: "deepseek-v4.1-flash" }
] as CatalogModel[];

type BoundCurrent = Extract<ShellComposerAssistant, { state: "bound" }>;

/** A bound Assistant whose rows all come from it, with the given changes. */
export function chatHeaderGalleryBound(
  source: AssistantSummary,
  overrides: Partial<Omit<BoundCurrent, "rows">> & {
    modelOrigin?: BoundCurrent["rows"]["model"]["origin"];
    modelPolicy?: BoundCurrent["rows"]["model"]["policy"];
  } = {}
): BoundCurrent {
  const { modelOrigin = "assistant", modelPolicy = "adjustable", ...rest } = overrides;
  const row = <Value,>(assistantValue: Value, value: Value) => ({
    assistantValue,
    deviation: null,
    origin: "assistant" as const,
    policy: "adjustable" as const,
    value
  });
  return {
    availability: source.availability,
    avatar: source.avatar,
    blockReason: null,
    changedRows: modelOrigin === "chat" ? ["model"] : [],
    description: source.description,
    id: source.id,
    includedSkills: [],
    name: source.name,
    owned: source.owned,
    ownerDisplayName: source.ownerDisplayName,
    rows: {
      controls: row({}, {}),
      model: {
        assistantValue: { mode: "model", modelId: "gemini-3.8-flash" },
        deviation: null,
        origin: modelOrigin,
        policy: modelPolicy,
        value: { mode: "model", modelId: modelOrigin === "chat" ? "claude-sonnet-5" : "gemini-3.8-flash" }
      },
      search: row({ mode: "off" as const }, { mode: "off" as const }),
      skills: row({ links: [], mode: "auto" as const }, { links: [], mode: "auto" as const }),
      tools: row({ mode: "off" as const }, { mode: "off" as const })
    },
    scope: "chat",
    starterPrompts: [],
    state: "bound",
    ...rest
  };
}

const [hr, , , , jira, sales] = chatHeaderGalleryAssistants as [
  AssistantSummary, AssistantSummary, AssistantSummary, AssistantSummary, AssistantSummary, AssistantSummary
];

const BLOCKED = "Nothing is sent until you choose.";

/** The chat's Assistant for each gallery state. */
export function chatHeaderGalleryCurrent(state: ChatHeaderGalleryState): ShellComposerAssistant | null {
  switch (state) {
    case "chosen":
      return chatHeaderGalleryBound(hr);
    case "menu":
    case "changed":
      return chatHeaderGalleryBound(hr, { modelOrigin: "chat" });
    case "fixed":
      return chatHeaderGalleryBound(hr, { modelPolicy: "fixed" });
    case "unavailable-owner":
      return chatHeaderGalleryBound(jira, { blockReason: BLOCKED });
    case "unavailable-consumer":
      return chatHeaderGalleryBound(sales, { blockReason: BLOCKED });
    case "archived-owner":
      return chatHeaderGalleryBound(hr, { availability: { ok: false, reason: "archived" }, blockReason: BLOCKED });
    case "archived-consumer":
      // A consumer learns only that the owner archived it: no name, no avatar.
      return { blockReason: BLOCKED, reason: "archived", scope: "chat", state: "unavailable" };
    case "deleted":
      return { blockReason: BLOCKED, scope: "chat", state: "deleted" };
    default:
      return null;
  }
}

const navigationChats: ChatNavigationSummaryWire[] = [{
  activeRun: false,
  assistant: null,
  folderId: null,
  id: "chat-header-fixture",
  title: "Vacation policy questions",
  updatedAt: "2026-09-27T08:00:00.000Z"
}];

export function ChatHeaderV2Gallery({ state }: Readonly<{ state: ChatHeaderGalleryState }>) {
  const [current, setCurrent] = useState<ShellComposerAssistant | null>(() => chatHeaderGalleryCurrent(state));
  const [pickerOpen, setPickerOpen] = useState(false);
  const selectorRef = useRef<HTMLButtonElement | null>(null);
  const openedStateRef = useRef<ChatHeaderGalleryState | null>(null);
  const blank = ["empty", "picker"].includes(state);
  const modelName = current?.state === "bound" && current.rows.model.origin === "chat"
    ? "Claude Sonnet 5"
    : current?.state === "bound" && current.rows.model.origin !== "fallback" ? "Gemini 3.8 Flash" : "DeepSeek V4.1 Flash";
  const provenance = headerModelProvenanceV2(current, modelName, models);

  // Menus and the picker open through the same trigger a user presses.
  useEffect(() => {
    if (openedStateRef.current === state || !["menu", "picker"].includes(state)) return;
    const frame = window.requestAnimationFrame(() => {
      openedStateRef.current = state;
      selectorRef.current?.click();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [state]);

  const choose = (assistantId: string) => {
    const chosen = chatHeaderGalleryAssistants.find((assistant) => assistant.id === assistantId);
    if (chosen) setCurrent(chatHeaderGalleryBound(chosen));
    setPickerOpen(false);
  };
  const assistant: HeaderAssistantSelectorActionsV2 = {
    canSaveChatSetup: current?.state === "bound" && current.owned && current.changedRows.length > 0,
    continueWithout: () => setCurrent(null),
    copyLink: () => undefined,
    current,
    editById: () => undefined,
    openPicker: pickerOpen,
    pending: false,
    remove: () => setCurrent(null),
    restore: () => setCurrent((value) => value?.state === "bound"
      ? { ...value, availability: { ok: true }, blockReason: null }
      : value),
    saveChatSetup: () => setCurrent((value) => value?.state === "bound" ? chatHeaderGalleryBound(hr) : value),
    setPickerOpen
  };

  const sidebar = (onClose: () => void) => (
    <NavigationSidebar
      activeChatId={blank ? null : "chat-header-fixture"}
      chats={navigationChats}
      error={null}
      folders={[]}
      hasMore={false}
      loading={false}
      now={new Date("2026-09-27T12:00:00.000Z")}
      onClose={onClose}
      onLoadMore={() => undefined}
      onNewChat={() => undefined}
      onRetry={() => undefined}
      onSearch={() => undefined}
      onSelectChat={() => undefined}
      ready
      searchError={null}
      searchLoading={false}
      searchQuery=""
    />
  );

  return (
    <div data-testid="ui-v2-chat-header-gallery">
      <ReadingRoomShellV2
        chatActive={!blank}
        onNewChat={() => undefined}
        onSelectChat={() => undefined}
        sidebar={sidebar}
      >
        <section className="v2-live-workspace">
          <div className="v2-live-conversation">
            <WorkspaceHeaderV2
              active={!blank}
              assistantSelector={<HeaderAssistantSelectorV2 assistant={assistant} triggerRef={selectorRef} />}
              modelSelector={{
                expanded: false,
                family: current?.state === "bound" ? "gemini" : "deepseek",
                fromAssistant: provenance.fromAssistant,
                label: "Provider",
                locked: provenance.locked,
                name: modelName,
                onToggle: () => undefined,
                title: provenance.title
              }}
              onArchive={() => undefined}
              onBranches={() => undefined}
              onCopyThread={() => undefined}
              onExport={() => undefined}
              onRenameCancel={() => undefined}
              onRenameChange={() => undefined}
              onRenameSave={() => ({ ok: true })}
              onRenameStart={() => undefined}
              onShare={() => undefined}
              shareDisabled={false}
              temporaryMemory={null}
              title="Vacation policy questions"
            />
            <ConversationV2
              messages={blank ? [] : [{
                content: "How many vacation days do I get in my first year, and can I carry them over?",
                id: "header-question",
                role: "user"
              }, {
                content: "In your first year you accrue 2 days per month from your start date, up to 24 days.",
                id: "header-answer",
                role: "assistant"
              }]}
              orientationSlot={blank && current?.state === "bound" ? (
                <AssistantIntroV2
                  avatar={current.avatar}
                  description={current.description}
                  name={current.name}
                  owned={current.owned}
                  ownerDisplayName={current.ownerDisplayName}
                />
              ) : undefined}
            />
            <div className="v2-live-composer-dock">
              <AssistantBindingNoticeV2
                current={current}
                onChooseAnother={() => setPickerOpen(true)}
                onContinueWithout={() => setCurrent(null)}
                onOpenInStudio={() => undefined}
                onRestore={assistant.restore}
                pending={false}
              />
            </div>
          </div>
        </section>
      </ReadingRoomShellV2>
      {pickerOpen ? (
        <AssistantPickerV2
          anchorRef={selectorRef}
          assistants={chatHeaderGalleryAssistants}
          currentAssistantId={current?.state === "bound" ? current.id : null}
          loading={false}
          onBrowse={() => setPickerOpen(false)}
          onClose={() => setPickerOpen(false)}
          onSelect={choose}
          recentIds={chatHeaderGalleryRecentIds}
        />
      ) : null}
    </div>
  );
}
