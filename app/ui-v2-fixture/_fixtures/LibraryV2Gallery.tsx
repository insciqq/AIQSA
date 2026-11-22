"use client";

import { UiV2Button } from "@/components/ui-v2";
import { SkillLibrarySection } from "@/components/skills/SkillLibraryDialog";
import { useState } from "react";
import { AssistantGalleryV2 } from "@/features/library-v2/assistants/gallery/AssistantGalleryV2";
import {
  FilesPanelV2,
  LibraryV2,
  SectionHeading
} from "@/features/library-v2/LibraryV2";
import type {
  LibraryNavigationIntentV2,
  LibraryTabIdV2,
  LibraryTabV2
} from "@/features/library-v2/contracts";
import { ASSISTANT_FIXTURE_SUMMARIES, fixtureGalleryView } from "./AssistantsGalleryFixtureV2";

export type LibraryGalleryStateV2 =
  | "all-sections"
  | "assistants"
  | "dirty"
  | "files"
  | "memory"
  | "memory-disabled"
  | "skills";

const assistants = ASSISTANT_FIXTURE_SUMMARIES.filter((assistant) =>
  ["research-analyst", "translator", "sales-brief"].includes(assistant.id));

const files = [
  {
    byteSize: 1240,
    canOpenChat: false,
    chatId: null,
    chatTitle: null,
    createdAt: "2026-09-01T09:00:00.000Z",
    id: "template",
    name: "prompt_template.md",
    previewKind: "text",
    savedAt: "2026-09-12T09:00:00.000Z",
    status: "ready" as const
  },
  {
    byteSize: 214000,
    canOpenChat: true,
    chatId: "quarterly",
    chatTitle: "Quarterly product brief",
    createdAt: "2026-09-21T14:31:00.000Z",
    id: "sales",
    name: "sales_q3.csv",
    previewKind: "text",
    savedAt: null,
    status: "ready" as const
  },
  {
    byteSize: 2048000,
    id: "scan",
    canOpenChat: true,
    chatId: "quarterly",
    chatTitle: "Quarterly product brief",
    createdAt: "2026-09-21T14:02:00.000Z",
    name: "contract_scan.pdf",
    previewKind: null,
    savedAt: null,
    status: "processing" as const
  }
] as const;

export function LibraryV2Gallery({ state = "assistants" }: { state?: LibraryGalleryStateV2 }) {
  const initialTab: LibraryTabIdV2 = state === "memory-disabled" ? "memory" : state === "dirty" || state === "all-sections" ? "assistants" : state;
  const [dirty, setDirty] = useState(state === "dirty");
  const [pending, setPending] = useState<Readonly<{
    intent: LibraryNavigationIntentV2;
    proceed(): void;
  }> | null>(null);
  const [closed, setClosed] = useState(false);
  const [selectedSkillIds, setSelectedSkillIds] = useState<readonly string[]>([]);
  const sectionLabel = initialTab === "assistants"
    ? "Assistants"
    : initialTab === "files"
      ? "Files"
      : initialTab === "memory"
        ? "Memory"
        : "Skills";

  if (closed) {
    return (
      <main className="v2-library-fixture-return">
        <p>The chat is open again.</p>
        <UiV2Button onClick={() => setClosed(false)}>Open {sectionLabel}</UiV2Button>
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
          ...(state === "all-sections" ? [
            { id: "instructions", label: "Instructions" }, { id: "mcp", label: "MCP servers", attention: true },
            { id: "secrets", label: "Secrets" }, { id: "defaults", label: "Chat defaults" },
            { id: "artifacts", label: "Artifacts" }
          ].map(tab => ({ ...tab, content: <SectionHeading description="Section composition fixture">{tab.label}</SectionHeading> })) as LibraryTabV2[] : []),
          {
            content: (
              <div>
                {dirty ? (
                  <div className="v2-library-draft-notice" role="status">
                    The Assistant draft changed. Its owner requires an explicit exit.
                  </div>
                ) : null}
                <AssistantGalleryV2
                  busy={false}
                  catalogError={null}
                  catalogState="ready"
                  gallery={fixtureGalleryView(assistants, () => setDirty(true))}
                  notice={null}
                  onDismissNotice={() => undefined}
                  onFromCurrentChat={() => setDirty(true)}
                  onNewAssistant={() => setDirty(true)}
                  onRetry={() => undefined}
                />
              </div>
            ),
            id: "assistants",
            label: "Assistants"
          },
          {
            content: <FilesPanelV2 files={files} onOpen={() => setClosed(true)} onUse={() => setClosed(true)} />,
            id: "files",
            label: "Files"
          },
          {
            // The note's section reads its owner routes; the gallery shows only its place among the sections.
            content: <SectionHeading description="Memory section fixture">Memory</SectionHeading>,
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
            label: "Skills"
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
