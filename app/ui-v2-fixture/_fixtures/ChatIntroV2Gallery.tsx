"use client";

import type { ShellComposerAssistant } from "@/components/app-shell/powerAppShellV2Contracts";
import type { AssistantIdentity, AssistantSummary } from "@/lib/contracts/assistants";
import type { ChatNavigationSummaryWire } from "@/lib/contracts/chats";
import {
  AnswerIdentityChipV2,
  answerIdentityV2,
  previousVisibleAnswersV2
} from "@/features/answer-outputs-v2/AnswerIdentityV2";
import { AssistantPickerV2 } from "@/features/composer-v2/AssistantPickerV2";
import { ComposerV2 } from "@/features/composer-v2/ComposerV2";
import { ConversationV2, type ConversationMessageV2 } from "@/features/conversation-v2/ConversationV2";
import { NavigationSidebar, ReadingRoomShellV2 } from "@/features/navigation-v2/NavigationV2";
import { AssistantIntroV2, AssistantStartersV2 } from "@/features/workspace-v2/AssistantIntroV2";
import { AssistantStripV2, assistantStripItemsV2 } from "@/features/workspace-v2/AssistantStripV2";
import {
  HeaderAssistantSelectorV2,
  headerModelProvenanceV2,
  type HeaderAssistantSelectorActionsV2
} from "@/features/workspace-v2/HeaderAssistantSelectorV2";
import { WorkspaceHeaderV2 } from "@/features/workspace-v2/WorkspaceHeaderV2";
import { useRef, useState } from "react";
import { chatHeaderGalleryAssistants, chatHeaderGalleryBound } from "./ChatHeaderV2Gallery";
import { composerGalleryConfig } from "./ComposerV2Gallery";

export type ChatIntroGalleryState = "identity" | "intro" | "intro-long" | "no-strip" | "strip";

const [hr, reviewer, notes, analyst, jira, sales] = chatHeaderGalleryAssistants as [
  AssistantSummary, AssistantSummary, AssistantSummary, AssistantSummary, AssistantSummary, AssistantSummary
];

const HR_STARTERS = [
  "How many vacation days do I have left?",
  "Explain the parental leave policy",
  "What is covered by the health plan?",
  "Who approves remote work requests?"
];

const longAssistant: AssistantSummary = {
  ...analyst,
  description: [
    "Reviews supplier contracts, purchase orders and renewal notices against the regional procurement policy,",
    "flags clauses that need legal sign-off, compares prices with the approved vendor list and drafts a short",
    "memo for the budget owner. It never approves spend on its own and always names the policy section it relies on,",
    "so every reviewer can check the source before a purchase order goes out to the supplier."
  ].join(" "),
  id: "assistant-procurement",
  name: "Quarterly procurement and compliance reviewer for EMEA suppliers",
  owned: false,
  ownerDisplayName: "Dana Ivanova",
  pinned: true,
  starterPrompts: [
    // The longest starter an author can save (200 characters): two lines, then the ellipsis.
    [
      "Check this supplier contract against the procurement policy and list every clause that needs legal sign-off,",
      "naming the policy section each one relies on and a one-line reason any reviewer can verify."
    ].join(" "),
    "Compare these three quotes with the approved vendor list",
    "Draft a renewal memo for the budget owner",
    "Which purchases above the regional threshold need a second approver this quarter?"
  ]
};

function variant(source: AssistantSummary, id: string, name: string, overrides: Partial<AssistantSummary>): AssistantSummary {
  return { ...source, availability: { ok: true }, featured: false, featuredOrder: null, id, name, pinned: false, ...overrides };
}

/**
 * Thirteen offers, the most a strip can have: five pinned (two with long
 * names), then eight Featured in Featured order. Unavailable and archived
 * Assistants are listed but never offered. The strip keeps two lines.
 */
const stripAssistants: AssistantSummary[] = [
  { ...hr, featured: true, featuredOrder: 2, starterPrompts: HR_STARTERS },
  { ...notes, pinned: true },
  longAssistant,
  variant(jira, "assistant-travel", "Travel and expense policy assistant for field teams", { pinned: true }),
  variant(sales, "assistant-onboarding", "Onboarding buddy", { pinned: true }),
  { ...analyst, featured: true, featuredOrder: 1 },
  reviewer,
  variant(notes, "assistant-escalations", "Customer escalation summarizer for enterprise accounts", { featured: true, featuredOrder: 3 }),
  variant(hr, "assistant-sql", "SQL helper", { featured: true, featuredOrder: 4 }),
  variant(jira, "assistant-release", "Release notes writer", { featured: true, featuredOrder: 5 }),
  variant(analyst, "assistant-brand", "Brand voice editor", { featured: true, featuredOrder: 6 }),
  variant(sales, "assistant-security", "Security questionnaire drafter", { featured: true, featuredOrder: 7 }),
  variant(reviewer, "assistant-interviews", "Interview kit builder", { featured: true, featuredOrder: 8 }),
  { ...sales, featured: true, featuredOrder: 0 },
  { ...notes, archived: true, id: "assistant-archived", name: "Old onboarding helper", pinned: true }
];

/** Nothing pinned and nothing Featured: the blank chat shows no strip. */
const plainAssistants: AssistantSummary[] = stripAssistants.map((assistant) => ({
  ...assistant,
  featured: false,
  featuredOrder: null,
  pinned: false
}));

function bound(source: AssistantSummary): Extract<ShellComposerAssistant, { state: "bound" }> {
  return chatHeaderGalleryBound(source, { scope: "composer", starterPrompts: source.starterPrompts });
}

function initialAssistant(state: ChatIntroGalleryState): ShellComposerAssistant | null {
  if (state === "intro") return bound({ ...hr, owned: false, starterPrompts: HR_STARTERS });
  if (state === "intro-long") return bound(longAssistant);
  return null;
}

const hrIdentity: AssistantIdentity = { avatar: hr.avatar, name: hr.name };
const reviewerIdentity: AssistantIdentity = { avatar: reviewer.avatar, name: reviewer.name };

/** The Assistant changes from HR Helper to Code reviewer and then to none (removed for this chat). */
const identityThread: (ConversationMessageV2 & { assistantIdentity?: AssistantIdentity | null })[] = [
  { content: "How many vacation days do I get in my first year?", id: "q1", role: "user" },
  { assistantIdentity: hrIdentity, content: "You accrue 2 days per month from your start date, up to 24 days.", id: "a1", role: "assistant" },
  { content: "And if I take parental leave in that year?", id: "q2", role: "user" },
  { assistantIdentity: hrIdentity, content: "Accrual continues during paid parental leave and pauses during unpaid leave.", id: "a2", role: "assistant" },
  { content: "Review the leave calculator change in this pull request.", id: "q3", role: "user" },
  { assistantIdentity: reviewerIdentity, content: "The accrual cap is applied before the carry-over, so the carried days can exceed 24.", id: "a3", role: "assistant" },
  { content: "Summarize the thread in two lines.", id: "q4", role: "user" },
  { assistantIdentity: null, content: "Vacation accrues monthly up to 24 days; the calculator applies the cap too early.", id: "a4", role: "assistant" },
  { content: "Thanks.", id: "q5", role: "user" },
  { assistantIdentity: null, content: "You're welcome.", id: "a5", role: "assistant" }
];

const identityById = new Map(identityThread.map((message) => [message.id, message]));
const previousAnswers = previousVisibleAnswersV2(identityThread);

const navigationChats: ChatNavigationSummaryWire[] = [{
  activeRun: false,
  assistant: null,
  folderId: null,
  id: "chat-intro-fixture",
  title: "Vacation policy questions",
  updatedAt: "2026-09-27T08:00:00.000Z"
}];

/**
 * The blank chat's quiet rows and the answer identity chip: strip, no strip,
 * intro with starters, a long intro, and a thread where the Assistant changes.
 * Typing a draft shows that the rows keep their space.
 */
export function ChatIntroV2Gallery({ state }: Readonly<{ state: ChatIntroGalleryState }>) {
  const [current, setCurrent] = useState<ShellComposerAssistant | null>(() => initialAssistant(state));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const selectorRef = useRef<HTMLButtonElement | null>(null);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const conversation = state === "identity";
  const assistants = state === "no-strip" ? plainAssistants : stripAssistants;
  const stripItems = current ? [] : assistantStripItemsV2(assistants);
  const modelName = current?.state === "bound" ? "Gemini 3.8 Flash" : "DeepSeek V4.1 Flash";
  const provenance = headerModelProvenanceV2(current, modelName, []);
  const idle = !draft.trim();
  const choose = (assistantId: string) => {
    const chosen = assistants.find((assistant) => assistant.id === assistantId);
    if (chosen) setCurrent(bound(chosen));
    setPickerOpen(false);
  };
  const focusComposer = () => stackRef.current?.querySelector("textarea")?.focus({ preventScroll: true });
  const assistant: HeaderAssistantSelectorActionsV2 = {
    canSaveChatSetup: false,
    continueWithout: () => setCurrent(null),
    copyLink: () => undefined,
    current,
    editById: () => undefined,
    openPicker: pickerOpen,
    pending: false,
    remove: () => setCurrent(null),
    saveChatSetup: () => undefined,
    setPickerOpen
  };
  const composer = (
    <ComposerV2
      config={composerGalleryConfig}
      draft={draft}
      onDraftChange={setDraft}
      onSend={() => setDraft("")}
      selectedModelId="gpt-5.2"
      selectedProvider="openai-work"
    />
  );

  const sidebar = (onClose: () => void) => (
    <NavigationSidebar
      activeChatId={conversation ? "chat-intro-fixture" : null}
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
    <div data-testid="ui-v2-chat-intro-gallery">
      <ReadingRoomShellV2
        chatActive={conversation}
        onNewChat={() => undefined}
        onSelectChat={() => undefined}
        sidebar={sidebar}
      >
        <section className="v2-live-workspace">
          <div className="v2-live-conversation">
            <WorkspaceHeaderV2
              active={conversation}
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
              composerSlot={conversation ? undefined : (
                <div className="v2-live-empty-composer-stack" ref={stackRef}>
                  {composer}
                  {stripItems.length > 0 ? (
                    <AssistantStripV2
                      idle={idle}
                      items={stripItems}
                      onChoose={choose}
                      onOpenPicker={() => setPickerOpen(true)}
                      restoreFocus={focusComposer}
                    />
                  ) : current?.state === "bound" && current.starterPrompts.length > 0 ? (
                    <AssistantStartersV2
                      idle={idle}
                      onSend={() => undefined}
                      prompts={current.starterPrompts}
                      restoreFocus={focusComposer}
                    />
                  ) : null}
                </div>
              )}
              getMessagePresentation={(message) => {
                const source = message.role === "assistant" ? identityById.get(message.id) : undefined;
                const identity = source ? answerIdentityV2(source, previousAnswers.get(message.id) ?? null) : null;
                return identity ? { beforeContent: <AnswerIdentityChipV2 identity={identity} /> } : undefined;
              }}
              messages={conversation ? identityThread : []}
              orientationSlot={current?.state === "bound" && !conversation ? (
                <AssistantIntroV2
                  avatar={current.avatar}
                  description={current.description}
                  name={current.name}
                  owned={current.owned}
                  ownerDisplayName={current.ownerDisplayName}
                  projectName={current.project ? current.projectName ?? null : undefined}
                />
              ) : undefined}
            />
            {conversation ? <div className="v2-live-composer-dock">{composer}</div> : null}
          </div>
        </section>
      </ReadingRoomShellV2>
      {pickerOpen ? (
        <AssistantPickerV2
          anchorRef={selectorRef}
          assistants={assistants}
          currentAssistantId={current?.state === "bound" ? current.id : null}
          loading={false}
          onBrowse={() => setPickerOpen(false)}
          onClose={() => setPickerOpen(false)}
          onSelect={choose}
          projectScoped={false}
          recentIds={[]}
        />
      ) : null}
    </div>
  );
}
