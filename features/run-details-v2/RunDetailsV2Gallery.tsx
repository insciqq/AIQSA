"use client";

import type { ChatNavigationSummaryWire } from "@/lib/contracts/chats";
import type { PersistedRun } from "@/lib/contracts/runs";
import {
  NavigationSidebar,
  ReadingRoomShellV2
} from "@/features/navigation-v2/NavigationV2";
import {
  ConversationV2,
  type ConversationMessageV2
} from "@/features/conversation-v2/ConversationV2";
import { EvidenceRowV2 } from "@/features/evidence-v2/EvidenceV2";
import { useCallback, useState } from "react";
import { ExactRunDetailsDrawerV2 } from "./RunDetailsV2";
import {
  runDetailsCatalogFixture,
  runDetailsFixtureForState,
  runDetailsGeneratedFileFacts,
  runDetailsTargetFixture,
  type RunDetailsFixtureState
} from "./fixtures";

const navigationChats: ChatNavigationSummaryWire[] = [{
  activeRun: false,
  folderId: null,
  id: "run-details-fixture",
  title: "Quarterly run inspection",
  updatedAt: "2026-08-13T11:32:19.000Z"
}];

const messages: readonly ConversationMessageV2[] = [{
  content: "Собери проверяемый квартальный отчёт и покажи точные evidence receipts.",
  id: "run-details-question",
  role: "user"
}, {
  content: "Подготовил отчёт. Источники, инструменты, принятые bindings и frozen Memory evidence доступны отдельно от ответа.",
  id: runDetailsTargetFixture.assistantMessageId,
  role: "assistant"
}];

export function RunDetailsV2Gallery({
  state = "closed"
}: {
  state?: RunDetailsFixtureState;
}) {
  const fixtureRun = runDetailsFixtureForState(state);
  const [cachedRun, setCachedRun] = useState<PersistedRun | null>(() =>
    state === "error" || state === "loading" ? null : fixtureRun
  );
  const [open, setOpen] = useState(state !== "closed");
  const [notice, setNotice] = useState("");
  const loadRun = useCallback(async (runId: string) => {
    if (state === "loading") return new Promise<PersistedRun | null>(() => undefined);
    if (state === "error" || !fixtureRun || runId !== runDetailsTargetFixture.runId) return null;
    await Promise.resolve();
    setCachedRun(fixtureRun);
    return fixtureRun;
  }, [fixtureRun, state]);

  const sidebar = (onClose: () => void) => (
    <NavigationSidebar
      activeChatId="run-details-fixture"
      chats={navigationChats}
      error={null}
      folders={[]}
      hasMore={false}
      loading={false}
      now={new Date("2026-08-13T12:00:00.000Z")}
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
    <div data-testid="ui-v2-run-details-gallery" data-state={state}>
      <ReadingRoomShellV2
        onNewChat={() => undefined}
        onSelectChat={() => undefined}
        sidebar={sidebar}
      >
        <main className="v2-run-details-gallery-main">
          <ConversationV2
            getMessagePresentation={(message) => message.role === "assistant" ? {
              afterContent: (
                <EvidenceRowV2
                  onOpenRunDetails={() => setOpen(true)}
                  summary={{ fileCount: 2, hasUsage: true, sourceCount: 6, toolCallCount: 1 }}
                />
              )
            } : undefined}
            messages={messages}
          />
          <p aria-live="polite" className="v2-run-details-gallery-notice">{notice}</p>
        </main>
      </ReadingRoomShellV2>
      {open ? (
        <ExactRunDetailsDrawerV2
          cachedRun={cachedRun}
          catalog={runDetailsCatalogFixture}
          generatedFiles={runDetailsGeneratedFileFacts}
          key={runDetailsTargetFixture.runId}
          loadRun={loadRun}
          onClose={() => setOpen(false)}
          onOpenMemorySource={() => setNotice("Источник открыт бы owner-private навигацией; fixture не меняет workspace.")}
          target={runDetailsTargetFixture}
        />
      ) : null}
    </div>
  );
}
