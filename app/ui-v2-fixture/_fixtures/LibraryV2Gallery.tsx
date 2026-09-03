"use client";

import { UiV2Button } from "@/components/ui-v2";
import { SkillLibrarySection } from "@/components/skills/SkillLibraryDialog";
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
import type { MemoryConsumerItem } from "@/lib/contracts/memoryConsumer";

export type LibraryGalleryStateV2 =
  | "assistants"
  | "dirty"
  | "files"
  | "knowledge"
  | "memory"
  | "memory-disabled"
  | "skills";

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
    unavailable: {
      explanation: "A saved dependency is not available to you.",
      headline: "Required access unavailable"
    }
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
    status: "processing" as const
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

const memoryItems: readonly MemoryConsumerItem[] = [
  {
    allowedActions: ["EDIT", "FORGET"],
    category: "ABOUT_YOU",
    createdAt: "2026-08-12T10:00:00.000Z",
    memoryRef: "memory-gallery-about",
    provenance: "SAVED",
    sourceAvailable: true,
    statement: "Works as a platform engineer on the ingest team.",
    updatedAt: "2026-09-01T10:00:00.000Z"
  },
  {
    allowedActions: ["EDIT", "FORGET"],
    category: "PREFERENCES",
    createdAt: "2026-08-22T10:00:00.000Z",
    memoryRef: "memory-gallery-preference",
    provenance: "LEARNED",
    sourceAvailable: false,
    statement: "Prefers SQL over ORM query builders in examples.",
    updatedAt: "2026-08-22T10:00:00.000Z"
  },
  {
    allowedActions: ["EDIT", "FORGET"],
    category: "CONSTRAINTS_AND_ROUTINES",
    createdAt: "2026-08-25T10:00:00.000Z",
    memoryRef: "memory-gallery-long-routine",
    provenance: "LEARNED",
    sourceAvailable: false,
    statement: "Release process: every change to the ingest path goes through a migration note in the Release project, a dry run against the staging corpus and a go/no-go on Thursday; Friday is a freeze day, so anything not signed off by Thursday 16:00 CET waits until Monday, and the on-call engineer is allowed to roll back without asking if p95 goes over 600 ms for more than ten minutes.",
    updatedAt: "2026-08-25T10:00:00.000Z"
  },
  {
    allowedActions: ["EDIT", "FORGET"],
    category: "CONSTRAINTS_AND_ROUTINES",
    createdAt: "2026-08-20T10:00:00.000Z",
    memoryRef: "memory-gallery-routine",
    provenance: "SAVED",
    sourceAvailable: true,
    statement: "Never suggests emoji in commit messages.",
    updatedAt: "2026-08-20T10:00:00.000Z"
  },
  {
    allowedActions: ["EDIT"],
    category: "OTHER",
    createdAt: "2026-08-18T10:00:00.000Z",
    memoryRef: "memory-gallery-other",
    provenance: "SAVED",
    sourceAvailable: true,
    statement: "Keeps a standing note for uncategorized personal context.",
    updatedAt: "2026-08-18T10:00:00.000Z"
  }
];

export function LibraryV2Gallery({ state = "assistants" }: { state?: LibraryGalleryStateV2 }) {
  const initialTab: LibraryTabIdV2 = state === "memory-disabled" ? "memory" : state === "dirty" ? "assistants" : state;
  const [dirty, setDirty] = useState(state === "dirty");
  const [pending, setPending] = useState<Readonly<{
    intent: LibraryNavigationIntentV2;
    proceed(): void;
  }> | null>(null);
  const [closed, setClosed] = useState(false);
  const [memoryGates] = useState({ automatic: true, facts: true, history: true });
  const [memories, setMemories] = useState<readonly MemoryConsumerItem[]>(memoryItems);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memoryRow, setMemoryRow] = useState<Readonly<{
    memoryRef: string | null;
    mode: "create" | "edit" | "forget" | null;
  }>>({ memoryRef: null, mode: null });
  const [selectedSkillIds, setSelectedSkillIds] = useState<readonly string[]>([]);
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
          {
            content: <FilesPanelV2 files={files} onOpen={() => setClosed(true)} />,
            id: "files",
            label: "Files"
          },
          {
            content: (
              <MemoryPanelV2
                activeRef={memoryRow.memoryRef}
                busy={null}
                draft={memoryDraft}
                hasMore={false}
                items={memories.filter((item) => item.statement.toLocaleLowerCase().includes(memoryQuery.toLocaleLowerCase()))}
                listError={null}
                listState="ready"
                memory={{
                  administratorDisabled: disabled,
                  automaticLearning: memoryGates.automatic,
                  disabledReason: disabled ? "New answers do not use saved context; an administrator can change this policy." : undefined,
                  explicitCrudAvailable: true,
                  loadState: "ready",
                  referenceChatHistory: memoryGates.history,
                  status: disabled ? "NEEDS_ADMIN_SETUP" : "ON",
                  useMemoryFacts: memoryGates.facts
                }}
                mutationError={null}
                notice={null}
                onCancelRow={() => setMemoryRow({ memoryRef: null, mode: null })}
                onConfirmForget={() => {
                  setMemories((current) => current.filter((item) => item.memoryRef !== memoryRow.memoryRef));
                  setMemoryRow({ memoryRef: null, mode: null });
                }}
                onCreate={() => {
                  setMemoryDraft("");
                  setMemoryRow({ memoryRef: null, mode: "create" });
                }}
                onDraftChange={setMemoryDraft}
                onEdit={(memoryRef) => {
                  setMemoryDraft(memories.find((item) => item.memoryRef === memoryRef)?.statement ?? "");
                  setMemoryRow({ memoryRef, mode: "edit" });
                }}
                onForget={(memoryRef) => setMemoryRow({ memoryRef, mode: "forget" })}
                onLoadMore={() => undefined}
                onOpenSettings={() => undefined}
                onQueryChange={setMemoryQuery}
                onRetry={() => undefined}
                onSave={() => {
                  if (memoryRow.mode === "create") {
                    setMemories((current) => [{
                      allowedActions: ["EDIT", "FORGET"],
                      category: "OTHER",
                      createdAt: new Date().toISOString(),
                      memoryRef: `fixture-${current.length + 1}`,
                      provenance: "SAVED",
                      sourceAvailable: true,
                      statement: memoryDraft,
                      updatedAt: new Date().toISOString()
                    }, ...current]);
                  } else if (memoryRow.memoryRef) {
                    setMemories((current) => current.map((item) => item.memoryRef === memoryRow.memoryRef
                      ? { ...item, statement: memoryDraft }
                      : item));
                  }
                  setMemoryRow({ memoryRef: null, mode: null });
                }}
                onSubmitQuery={() => undefined}
                query={memoryQuery}
                searchActive={memoryQuery.trim().length > 0}
                rowMode={memoryRow.mode}
              />
            ),
            id: "memory",
            label: "Memory"
          },
          {
            content: (
              <SkillLibrarySection
                onSelectionChange={setSelectedSkillIds}
                selectedIds={selectedSkillIds}
              />
            ),
            id: "skills",
            label: "Skill library"
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
