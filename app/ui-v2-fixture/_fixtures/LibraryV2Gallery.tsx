"use client";

import { UiV2Button } from "@/components/ui-v2";
import { useState } from "react";
import {
  AssistantsPanelV2,
  FilesPanelV2,
  KnowledgePanelV2,
  LibraryV2,
  MemoryPanelV2
} from "@/features/library-v2/LibraryV2";
import type {
  LibraryNavigationIntentV2,
  LibraryTabIdV2
} from "@/features/library-v2/contracts";

export type LibraryGalleryStateV2 =
  | "assistants"
  | "dirty"
  | "files"
  | "knowledge"
  | "memory"
  | "memory-disabled";

const assistants = [
  {
    archived: false,
    available: true,
    description: "Собирает спокойные продуктовые брифы из проверяемых источников.",
    id: "research-editor",
    name: "Research editor",
    owned: true,
    pinned: true,
    revision: 7
  },
  {
    archived: false,
    available: true,
    description: "Проверяет релизные изменения и формирует короткий checklist.",
    id: "release-reviewer",
    name: "Release reviewer",
    owned: true,
    revision: 3
  },
  {
    archived: false,
    available: false,
    description: "Сопоставляет внутренние договоры и публичные требования.",
    id: "contract-analyst",
    name: "Contract analyst",
    owned: false,
    revision: 2,
    unavailableReason: "Required access unavailable"
  }
] as const;

const bases = [
  {
    description: "Утверждённые продуктовые решения и критерии готовности.",
    sourceCount: 18,
    id: "product",
    name: "Product decisions",
    owned: true,
    status: "ready" as const
  },
  {
    description: "Материалы квартального исследования, индекс строится.",
    sourceCount: 9,
    id: "research",
    name: "Research 2026",
    owned: true,
    status: "indexing" as const
  },
  {
    description: "Общая база команды поддержки.",
    sourceCount: 42,
    id: "support",
    name: "Support handbook",
    owned: false,
    status: "ready" as const
  }
] as const;

const files = [
  {
    id: "sales",
    meta: "From chat “Quarterly product brief” · 214 kB",
    name: "sales_q3.csv",
    private: true,
    status: "ready" as const
  },
  {
    id: "scan",
    meta: "OCR and text extraction",
    name: "contract_scan.pdf",
    private: true,
    status: "processing" as const
  }
] as const;

export function LibraryV2Gallery({ state = "assistants" }: { state?: LibraryGalleryStateV2 }) {
  const initialTab: LibraryTabIdV2 = state === "memory-disabled" ? "memory" : state === "dirty" ? "assistants" : state;
  const [dirty, setDirty] = useState(state === "dirty");
  const [pending, setPending] = useState<Readonly<{
    intent: LibraryNavigationIntentV2;
    proceed(): void;
  }> | null>(null);
  const [closed, setClosed] = useState(false);
  const [memoryGates, setMemoryGates] = useState({ automatic: true, facts: true, history: true });
  const disabled = state === "memory-disabled";

  if (closed) {
    return (
      <main className="v2-library-fixture-return">
        <p>The chat is open again.</p>
        <UiV2Button onClick={() => setClosed(false)}>Open Library</UiV2Button>
      </main>
    );
  }

  return (
    <>
      <LibraryV2
        initialTab={initialTab}
        navigationGuard={(intent, proceed) => {
          if (dirty && intent.from === "assistants") setPending({ intent, proceed });
          else proceed();
        }}
        onBack={() => setClosed(true)}
        tabs={[
          {
            content: (
              <div>
                {dirty ? (
                  <div className="v2-library-draft-notice" role="status">
                    The Assistant draft changed. Its owner requires an explicit exit.
                  </div>
                ) : null}
                <AssistantsPanelV2 assistants={assistants} onOpen={() => setDirty(true)} />
              </div>
            ),
            id: "assistants",
            label: "Assistants"
          },
          { content: <KnowledgePanelV2 bases={bases} />, id: "knowledge", label: "Knowledge" },
          { content: <FilesPanelV2 files={files} />, id: "files", label: "Files" },
          {
            content: (
              <MemoryPanelV2
                memory={{
                  administratorDisabled: disabled,
                  automaticLearning: memoryGates.automatic,
                  disabledReason: disabled ? "New answers do not use saved context; an administrator can change this policy." : undefined,
                  explicitCrudAvailable: true,
                  facts: [
                    { id: "fact-1", pinned: true, scope: "Global", statement: "Пользователь предпочитает краткие технические ответы." },
                    { id: "fact-2", scope: "Folder · Research", statement: "Для исследовательских отчётов нужен список первичных источников." }
                  ],
                  healthDetail: disabled ? "Automatic recall is stopped. Saved facts can still be reviewed and deleted." : "Facts and history are ready; background jobs are complete.",
                  healthLabel: disabled ? "Memory is not used in answers" : "Memory ready",
                  referenceChatHistory: memoryGates.history,
                  useMemoryFacts: memoryGates.facts
                }}
                onChangeAutomaticLearning={(automatic) => setMemoryGates((value) => ({ ...value, automatic }))}
                onChangeReferenceHistory={(history) => setMemoryGates((value) => ({ ...value, history }))}
                onChangeUseFacts={(facts) => setMemoryGates((value) => ({ ...value, facts }))}
              />
            ),
            id: "memory",
            label: "Memory"
          }
        ]}
      />
      {pending ? (
        <div className="v2-library-confirm-scrim" role="presentation">
          <section aria-label="Unsaved Assistant draft" aria-modal="true" className="v2-library-confirm" role="alertdialog">
            <h2>Discard changes?</h2>
            <p>The unsaved Assistant draft will be lost.</p>
            <div>
              <UiV2Button autoFocus onClick={() => {
                const source = pending.intent.from;
                setPending(null);
                window.requestAnimationFrame(() => {
                  document.getElementById(`v2-library-tab-${source}`)?.focus();
                });
              }}>Keep editing</UiV2Button>
              <UiV2Button tone="destructive" onClick={() => {
                const proceed = pending.proceed;
                setDirty(false);
                setPending(null);
                proceed();
              }}>Discard changes</UiV2Button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
