"use client";

import type { ChatNavigationSummaryWire } from "@/lib/contracts/chats";
import {
  NavigationSidebar,
  ReadingRoomShellV2
} from "@/features/navigation-v2/NavigationV2";
import {
  ConversationV2,
  type ConversationMessageV2
} from "@/features/conversation-v2/ConversationV2";
import { useState } from "react";
import {
  ArtifactPreviewDrawerV2,
  GeneratedArtifactStackV2
} from "@/features/artifacts-v2/ArtifactsV2";
import type {
  GeneratedArtifactProjection,
  GeneratedArtifactVersion
} from "@/features/artifacts-v2/contracts";
import {
  artifactFixturesForState,
  readyReportArtifact,
  type ArtifactsFixtureState
} from "./artifactFixtures";

const navigationChats: ChatNavigationSummaryWire[] = [{
  activeRun: false,
  folderId: null,
  id: "artifacts-fixture",
  title: "Quarterly file package",
  updatedAt: "2026-08-13T11:00:00.000Z"
}];

const messages: readonly ConversationMessageV2[] = [{
  content: "Собери квартальную книгу и презентацию, сохрани проверяемые версии.",
  id: "artifact-question",
  role: "user"
}, {
  content: "Подготовил файлы как отдельные неизменяемые результаты. Каждый файл привязан к этому ответу.",
  id: "artifact-answer",
  role: "assistant"
}];

export function ArtifactsV2Gallery({ state = "default" }: { state?: ArtifactsFixtureState }) {
  const artifacts = artifactFixturesForState(state);
  const [previewArtifact, setPreviewArtifact] = useState<Extract<
    GeneratedArtifactProjection,
    { status: "ready" }
  > | null>(() => state === "drawer" && readyReportArtifact.status === "ready"
    ? readyReportArtifact
    : null);
  const [notice, setNotice] = useState("");

  function exactVersionNotice(action: string, version: GeneratedArtifactVersion) {
    setNotice(`${action}: ${version.number === 1 ? "original" : `version ${version.number}`} · fixture-only, backend not connected.`);
  }

  const sidebar = (onClose: () => void) => (
    <NavigationSidebar
      activeChatId="artifacts-fixture"
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
    <div data-testid="ui-v2-artifacts-gallery" data-state={state}>
      <ReadingRoomShellV2
        onNewChat={() => undefined}
        onSelectChat={() => undefined}
        sidebar={sidebar}
      >
        <main className="v2-artifact-gallery-main">
          <ConversationV2
            getMessagePresentation={(message) => message.role === "assistant" ? {
              afterContent: (
                <>
                  <p className="v2-artifact-fixture-note">
                    Fixture-only preview · the generated-files backend is not available in the product.
                  </p>
                  <GeneratedArtifactStackV2
                    artifacts={artifacts}
                    onDetails={() => setNotice("Validation details are limited to this generated-output fixture.")}
                    onDownload={(_, version) => exactVersionNotice("Download not performed", version)}
                    onPreview={(artifact) => {
                      if (artifact.status === "ready") setPreviewArtifact(artifact);
                    }}
                    onRetry={() => setNotice("Retry not performed: the compute backend is not connected.")}
                    onUseInNextMessage={(_, version) => exactVersionNotice("Selected for the next message", version)}
                  />
                </>
              )
            } : undefined}
            messages={messages}
          />
          <p aria-live="polite" className="v2-artifact-gallery-notice">{notice}</p>
        </main>
      </ReadingRoomShellV2>
      {previewArtifact ? (
        <ArtifactPreviewDrawerV2
          artifact={previewArtifact}
          key={previewArtifact.id}
          onClose={() => setPreviewArtifact(null)}
          onDownload={(_, version) => exactVersionNotice("Download not performed", version)}
        />
      ) : null}
    </div>
  );
}
