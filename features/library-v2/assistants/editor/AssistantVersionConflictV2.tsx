"use client";

import type { AssistantEditorDraft, AssistantEditorView } from "@/components/assistants/libraryViewContracts";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import { ASSISTANT_CATEGORY_LABELS, ASSISTANT_ROW_KEYS } from "@/lib/contracts/assistants";
import { ASSISTANT_ROW_LABELS, assistantRowSummary } from "./assistantEditorSummaries";

/** Equal draft values: key order and undefined keys do not matter, list order does. */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const entries = (value: object) => Object.entries(value).filter(([, entry]) => entry !== undefined);
  const leftEntries = entries(left);
  const rightValues = new Map(entries(right));
  return leftEntries.length === rightValues.size &&
    leftEntries.every(([key, entry]) => rightValues.has(key) && sameValue(entry, rightValues.get(key)));
}

function categoryLabel(draft: AssistantEditorDraft): string {
  return draft.category ? ASSISTANT_CATEGORY_LABELS[draft.category] : "None";
}

function CompareLine({ differs, text }: Readonly<{ differs: boolean; text: string }>) {
  return (
    <li data-differs={differs || undefined}>
      {text}
      {differs ? <> — <span className="v2-assistant-conflict-differs">differs from your draft</span></> : null}
    </li>
  );
}

/**
 * The latest saved version beside the kept draft: its category, avatar and
 * Setup in the words of the collapsed Setup rows, marked where they differ,
 * then its texts. Reload is offered only while the latest version is not
 * loaded; once it is, the two choices stand alone.
 */
export function AssistantVersionConflictV2({ editor }: Readonly<{ editor: AssistantEditorView }>) {
  const conflict = editor.conflict;
  if (!conflict) return null;
  const latest = conflict.latest?.draft ?? null;
  const draft = editor.draft;
  const setupDiffers = latest
    ? ASSISTANT_ROW_KEYS.some((row) => !sameValue(latest.rows[row], draft.rows[row]))
    : false;
  return (
    <section className="v2-assistant-conflict" data-testid="assistant-editor-conflict" role="alert">
      <p><strong>This Assistant changed in another session.</strong> Your draft is kept. Compare it with the latest saved version, then choose.</p>
      {conflict.loading ? <p role="status">Loading the latest saved version…</p> : latest ? (
        <details className="v2-instructions-reminder">
          <summary className="v2-focusable">
            <UiV2Icon name="chevron-right" />
            <span>Latest saved version: {latest.name}</span>
          </summary>
          <ul className="v2-assistant-conflict-compare">
            <CompareLine differs={latest.category !== draft.category} text={`Category: ${categoryLabel(latest)}`} />
            {sameValue(latest.avatar, draft.avatar) ? null : <li data-differs>Avatar differs from your draft</li>}
            {setupDiffers ? ASSISTANT_ROW_KEYS.map((row) => (
              <CompareLine
                differs={!sameValue(latest.rows[row], draft.rows[row])}
                key={row}
                text={`${ASSISTANT_ROW_LABELS[row]}: ${assistantRowSummary(row, latest.rows, editor.options)} · ${latest.rows[row].policy === "fixed" ? "Fixed" : "Adjustable"}`}
              />
            )) : <li>Setup: same as your draft</li>}
          </ul>
          <pre>{[
            latest.description,
            latest.systemPrompt,
            latest.answerRules !== null ? `Answer rules:\n${latest.answerRules}` : "",
            latest.responseReminder ? `Response reminder:\n${latest.responseReminder}` : "",
            latest.starterPrompts.length > 0 ? `Starters:\n${latest.starterPrompts.join("\n")}` : ""
          ].filter(Boolean).join("\n\n")}</pre>
        </details>
      ) : <p>The latest saved version could not be loaded.</p>}
      <div className="v2-assistant-conflict-actions">
        {latest ? (
          <>
            <UiV2Button disabled={editor.saving} onClick={editor.onReplaceDraftWithLatest}>Replace draft with latest version</UiV2Button>
            <UiV2Button disabled={editor.saving} onClick={editor.onKeepDraftOverLatest}>Keep my draft</UiV2Button>
          </>
        ) : (
          <UiV2Button busy={conflict.loading} disabled={editor.saving} onClick={editor.onReloadLatest}>Reload latest version</UiV2Button>
        )}
      </div>
      {latest ? <p className="v2-assistant-conflict-note">Keep my draft replaces the other session&apos;s changes when you save.</p> : null}
    </section>
  );
}
