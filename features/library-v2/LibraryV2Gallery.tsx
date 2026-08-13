"use client";

import { UiV2Button } from "@/components/ui-v2";
import { useState } from "react";
import {
  AssistantsPanelV2,
  FilesPanelV2,
  KnowledgePanelV2,
  LibraryV2,
  MemoryPanelV2
} from "./LibraryV2";
import type { LibraryNavigationIntentV2, LibraryTabIdV2 } from "./contracts";

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
    documentCount: 18,
    id: "product",
    name: "Product decisions",
    owned: true,
    status: "ready" as const
  },
  {
    description: "Материалы квартального исследования, индекс строится.",
    documentCount: 9,
    id: "research",
    name: "Research 2026",
    owned: true,
    status: "indexing" as const
  },
  {
    description: "Общая база команды поддержки.",
    documentCount: 42,
    id: "support",
    name: "Support handbook",
    owned: false,
    status: "ready" as const
  }
] as const;

const files = [
  {
    id: "brief",
    kind: "generated" as const,
    meta: "v3 · 24 страницы · 618 kB",
    name: "quarterly_brief.docx",
    private: true,
    status: "ready" as const
  },
  {
    id: "sales",
    kind: "upload" as const,
    meta: "Из чата «Quarterly product brief» · 214 kB",
    name: "sales_q3.csv",
    private: true,
    status: "ready" as const
  },
  {
    id: "scan",
    kind: "upload" as const,
    meta: "OCR и извлечение текста",
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
        <p>Чат снова открыт.</p>
        <UiV2Button onClick={() => setClosed(false)}>Открыть библиотеку</UiV2Button>
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
                    Черновик Assistant изменён. Его владелец требует явного выхода.
                  </div>
                ) : null}
                <AssistantsPanelV2 assistants={assistants} onOpen={() => setDirty(true)} />
              </div>
            ),
            id: "assistants",
            label: "Assistants"
          },
          { content: <KnowledgePanelV2 bases={bases} />, id: "knowledge", label: "Knowledge" },
          { content: <FilesPanelV2 files={files} generatedFilesEnabled />, id: "files", label: "Файлы" },
          {
            content: (
              <MemoryPanelV2
                memory={{
                  administratorDisabled: disabled,
                  automaticLearning: memoryGates.automatic,
                  disabledReason: disabled ? "Новые ответы не используют сохранённый контекст; изменить политику может администратор." : undefined,
                  explicitCrudAvailable: true,
                  facts: [
                    { id: "fact-1", pinned: true, scope: "Global", statement: "Пользователь предпочитает краткие технические ответы." },
                    { id: "fact-2", scope: "Folder · Research", statement: "Для исследовательских отчётов нужен список первичных источников." }
                  ],
                  healthDetail: disabled ? "Автоматический recall остановлен. Сохранённые факты всё ещё можно просматривать и удалять." : "Факты и история готовы; фоновые задачи завершены.",
                  healthLabel: disabled ? "Memory не участвует в ответах" : "Memory готова",
                  referenceChatHistory: memoryGates.history,
                  useMemoryFacts: memoryGates.facts
                }}
                onChangeAutomaticLearning={(automatic) => setMemoryGates((value) => ({ ...value, automatic }))}
                onChangeReferenceHistory={(history) => setMemoryGates((value) => ({ ...value, history }))}
                onChangeUseFacts={(facts) => setMemoryGates((value) => ({ ...value, facts }))}
              />
            ),
            id: "memory",
            label: "Память"
          }
        ]}
      />
      {pending ? (
        <div className="v2-library-confirm-scrim" role="presentation">
          <section aria-label="Несохранённый черновик Assistant" aria-modal="true" className="v2-library-confirm" role="alertdialog">
            <h2>Отменить изменения?</h2>
            <p>Несохранённый черновик Assistant будет потерян.</p>
            <div>
              <UiV2Button autoFocus onClick={() => {
                const source = pending.intent.from;
                setPending(null);
                window.requestAnimationFrame(() => {
                  document.getElementById(`v2-library-tab-${source}`)?.focus();
                });
              }}>Продолжить редактирование</UiV2Button>
              <UiV2Button tone="destructive" onClick={() => {
                const proceed = pending.proceed;
                setDirty(false);
                setPending(null);
                proceed();
              }}>Отменить изменения</UiV2Button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
