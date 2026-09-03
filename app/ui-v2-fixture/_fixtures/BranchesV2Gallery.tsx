"use client";

import type {
  ChatBranchGraphWire,
  ChatNavigationSummaryWire
} from "@/lib/contracts/chats";
import {
  NavigationSidebar,
  ReadingRoomShellV2
} from "@/features/navigation-v2/NavigationV2";
import {
  ConversationV2,
  type ConversationMessageV2
} from "@/features/conversation-v2/ConversationV2";
import { SentAttachmentsV2 } from "@/features/attachments-v2/SentAttachmentsV2";
import { ComposerV2 } from "@/features/composer-v2/ComposerV2";
import { composerGalleryConfig } from "./ComposerV2Gallery";
import { UiV2Button } from "@/components/ui-v2";
import { useMemo, useState } from "react";
import {
  BranchDrawerV2,
  BranchPagerV2,
  BranchesSlotV2
} from "@/features/branches-v2/BranchesV2";
import {
  activeBranchPathV2,
  branchPagerForMessageV2
} from "@/features/branches-v2/branchModel";

export type BranchesGalleryState =
  | "default"
  | "drawer"
  | "edit"
  | "error"
  | "linear"
  | "loading"
  | "streaming";

const navigationChats: ChatNavigationSummaryWire[] = [{
  activeRun: false,
  folderId: null,
  id: "branches-fixture",
  title: "Версии исследования",
  updatedAt: "2026-08-13T10:00:00.000Z"
}];

const branchGraph: ChatBranchGraphWire = {
  activeLeafMessageId: "answer-edited",
  nodes: [
    {
      id: "question-root",
      parentMessageId: null,
      preview: "Сравни lexical и vector поиск на мультиязычном наборе.",
      role: "user",
      status: "complete"
    },
    {
      id: "answer-original",
      parentMessageId: "question-root",
      preview: "Первый ответ опирается только на lexical lane и служит исходной версией.",
      role: "assistant",
      status: "complete"
    },
    {
      id: "answer-regenerated",
      parentMessageId: "question-root",
      preview: "## Сравнение\n\nВторая версия разделяет lexical и vector измерения до финального отбора.",
      role: "assistant",
      status: "complete"
    },
    {
      id: "question-follow-up",
      parentMessageId: "answer-regenerated",
      preview: "Добавь критерий остановки для выборки.",
      role: "user",
      status: "complete"
    },
    {
      id: "answer-follow-up",
      parentMessageId: "question-follow-up",
      preview: "Остановитесь, когда новая выборка перестаёт менять top-5 и итоговую оценку.",
      role: "assistant",
      status: "complete"
    },
    {
      id: "question-edited",
      parentMessageId: "answer-regenerated",
      preview: "Добавь критерий остановки и контроль утечек скрытых данных.",
      role: "user",
      status: "complete"
    },
    {
      id: "answer-edited",
      parentMessageId: "question-edited",
      preview: "Критерий остановки проверяет стабильность top-5, а отдельный privacy-check подтверждает отсутствие скрытых идентификаторов.",
      role: "assistant",
      status: "complete"
    }
  ],
  snapshotUpdatedAt: "2026-08-13T10:00:00.000Z"
};

const linearGraph: ChatBranchGraphWire = {
  activeLeafMessageId: "linear-answer",
  nodes: [
    {
      id: "linear-question",
      parentMessageId: null,
      preview: "Сформулируй один критерий качества.",
      role: "user",
      status: "complete"
    },
    {
      id: "linear-answer",
      parentMessageId: "linear-question",
      preview: "Один критерий: вывод остаётся одинаковым на повторяемой контрольной выборке.",
      role: "assistant",
      status: "complete"
    }
  ],
  snapshotUpdatedAt: "2026-08-13T10:00:00.000Z"
};

function messageFromGraph(
  node: ChatBranchGraphWire["nodes"][number],
  streaming: boolean
): ConversationMessageV2 {
  return {
    content: node.preview,
    id: node.id,
    role: node.role,
    streaming: streaming && node.id === "answer-edited"
  };
}

export function BranchesV2Gallery({ state = "default" }: { state?: BranchesGalleryState }) {
  const baseGraph = state === "linear" ? linearGraph : branchGraph;
  const [graph, setGraph] = useState<ChatBranchGraphWire>(() => state === "streaming"
    ? {
        ...baseGraph,
        nodes: baseGraph.nodes.map((node) => node.id === baseGraph.activeLeafMessageId
          ? { ...node, status: "streaming" as const }
          : node)
      }
    : baseGraph);
  const [drawerOpen, setDrawerOpen] = useState(
    state === "drawer" || state === "error" || state === "loading" || state === "streaming"
  );
  const [editingMessageId, setEditingMessageId] = useState<string | null>(
    state === "edit" ? "question-edited" : null
  );
  const [editDraft, setEditDraft] = useState(
    state === "edit" ? "Добавь критерий остановки и контроль утечек скрытых данных." : ""
  );
  const [composerDraft, setComposerDraft] = useState("Незавершённый черновик остаётся в композере.");
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState(state === "error");
  const streaming = state === "streaming";
  const messages = useMemo(
    () => activeBranchPathV2(graph).map((node) => messageFromGraph(node, streaming)),
    [graph, streaming]
  );

  function checkout(leafId: string) {
    if (streaming) return false;
    setGraph((current) => ({ ...current, activeLeafMessageId: leafId }));
    setNotice("Version switched. The next message continues the selected branch.");
    return true;
  }

  const sidebar = (onClose: () => void) => (
    <NavigationSidebar
      activeChatId="branches-fixture"
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
    <div data-testid="ui-v2-branches-gallery" data-state={state}>
      <ReadingRoomShellV2
        onNewChat={() => undefined}
        onSelectChat={() => undefined}
        sidebar={sidebar}
      >
        <main
          className="v2-branch-gallery-main"
          data-composer-visible={state === "edit" || editingMessageId ? "true" : undefined}
        >
          <BranchesSlotV2>
            <UiV2Button icon="branch" onClick={() => setDrawerOpen(true)}>
              Branches
            </UiV2Button>
          </BranchesSlotV2>
          <ConversationV2
            getMessageActions={(message) => ({
              branchDisabled: streaming,
              deleteDisabled: streaming,
              disabledReason: streaming
                ? "Wait for the answer to finish or stop it."
                : null,
              editDisabled: streaming,
              moreDisabled: false,
              onBranchFromHere: () => setNotice("A new chat from this point was requested."),
              onCopy: () => setNotice("Message copied."),
              onDelete: () => setNotice("Deleting this branch requires confirmation."),
              ...(message.role === "user" ? {
                onEdit: () => {
                  setEditDraft(message.content);
                  setEditingMessageId(message.id);
                }
              } : {
                onRegenerate: () => setNotice("Regenerating creates a sibling answer version.")
              }),
              regenerateDisabled: streaming
            })}
            getMessagePresentation={(message) => {
              const pager = branchPagerForMessageV2(graph, message.id);
              const edit = editingMessageId === message.id ? {
                attachmentSlot: message.id === "question-edited" ? (
                  <SentAttachmentsV2
                    blocks={[{
                      attachmentId: "branches-fixture-report",
                      label: "privacy-check.md",
                      type: "file"
                    }]}
                  />
                ) : null,
                draft: editDraft,
                onCancel: () => setEditingMessageId(null),
                onChange: setEditDraft,
                onSubmit: () => {
                  setGraph((current) => ({
                    ...current,
                    nodes: current.nodes.map((node) => node.id === message.id
                      ? { ...node, preview: editDraft }
                      : node)
                  }));
                  setEditingMessageId(null);
                  setNotice("The new branch is saved; the original history is unchanged.");
                },
                sendWithEnter: true
              } : undefined;
              return pager || edit ? {
                ...(pager ? { afterContent: (
                  <BranchPagerV2
                    disabledReason={streaming
                      ? "Wait for the answer to finish or stop it."
                      : null}
                    onCheckout={checkout}
                    state={pager}
                  />
                ) } : {}),
                ...(edit ? { edit } : {})
              } : undefined;
            }}
            messages={messages}
          />
          <p aria-live="polite" className="v2-branch-gallery-notice">{notice}</p>
          {state === "edit" || editingMessageId ? (
            <div className="v2-composer-gallery-dock">
              <ComposerV2
                config={composerGalleryConfig}
                disabledReason={editingMessageId
                  ? "Finish or cancel the inline edit first."
                  : null}
                draft={composerDraft}
                onDraftChange={setComposerDraft}
                onSend={() => setNotice("The composer draft was sent unchanged.")}
                selectedModelId="gpt-5.2"
                selectedProvider="openai-work"
              />
            </div>
          ) : null}
        </main>
      </ReadingRoomShellV2>
      {drawerOpen ? (
        <BranchDrawerV2
          checkoutDisabledReason={streaming
            ? "Another version cannot be opened while the answer is running. Stop it or wait for it to finish."
            : null}
          error={loadError ? "branch_unavailable" : null}
          graph={state === "loading" ? null : graph}
          loading={state === "loading"}
          onCheckout={checkout}
          onClose={() => setDrawerOpen(false)}
          onRetry={() => setLoadError(false)}
        />
      ) : null}
    </div>
  );
}
