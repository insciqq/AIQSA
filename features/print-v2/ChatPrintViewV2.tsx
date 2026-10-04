"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { attachmentDownloadHref } from "@/components/app-shell/workspaceClient";
import { MarkdownMessage } from "@/components/chat/MarkdownMessage";
import { UiV2Button } from "@/components/ui-v2";
import type { ChatPrintDocument, ChatPrintTurn } from "@/lib/domain/chatPrintDocument";
import { waitForPrintSettle, type PrintSettleOutcome } from "./printSettle";

const GUTTER = "pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))]";

const subscribeNever = () => () => undefined;

/** False during server rendering and hydration, true afterwards. */
function useHydrated(): boolean {
  return useSyncExternalStore(subscribeNever, () => true, () => false);
}

function displayDate(iso: string, hydrated: boolean): string {
  // The server cannot know the reader's locale and time zone.
  return hydrated ? new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(new Date(iso)) : iso.slice(0, 10);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function PrintTurn({ turn }: { turn: ChatPrintTurn }) {
  const speaker = turn.role === "assistant" ? "Assistant" : "User";
  return (
    <article className="v2-print-turn min-w-0 py-5" data-role={turn.role} aria-label={speaker}>
      <p className="v2-print-speaker mb-2 text-xs font-semibold uppercase tracking-[0.06em] text-ink-muted">{speaker}</p>
      <div className={turn.role === "user" ? "v2-print-user min-w-0 border-l-2 border-trace-strong pl-4" : "min-w-0"}>
        {turn.text ? <MarkdownMessage content={turn.text} /> : null}
        {turn.images.map((image, index) => (
          <figure className="v2-print-image mt-4" key={`${image.attachmentId}-${index}`}>
            {/* Authenticated image bytes bypass the public Next image optimizer; printing needs them eagerly. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt={image.label}
              decoding="async"
              height={image.height}
              loading="eager"
              src={`${attachmentDownloadHref(image.attachmentId)}?preview=image`}
              width={image.width}
            />
          </figure>
        ))}
        {turn.files.length > 0 ? (
          <ul className="mt-3 space-y-1 text-sm text-ink-secondary" aria-label="Attachments">
            {turn.files.map((name, index) => (
              <li className="break-words [overflow-wrap:anywhere]" key={`${name}-${index}`}>Attachment: {name}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}

/**
 * The print page of a chat's visible branch. Paper is light, so this tab
 * uses the light theme. Once highlighting, math, diagrams, images and fonts
 * settle (or the cap passes) it opens the print dialog once; the button
 * stays for browsers that suppress an automatic dialog.
 */
export function ChatPrintViewV2({ document: printDocument }: { document: ChatPrintDocument }) {
  const rootRef = useRef<HTMLElement>(null);
  const printed = useRef(false);
  const [outcome, setOutcome] = useState<Exclude<PrintSettleOutcome, "aborted"> | null>(null);
  const hydrated = useHydrated();
  const title = printDocument.title.trim() || "Untitled chat";

  // Before any diagram reads the color scheme (layout effects run before the
  // diagrams' rendering effects); the app's stored theme stays unchanged.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.dataset.colorScheme = "light";
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const controller = new AbortController();
    void (async () => {
      const result = await waitForPrintSettle({
        fontsLoading: () => document.fonts?.status === "loading",
        root,
        signal: controller.signal
      });
      if (result === "aborted") return;
      document.title = printDocument.fileBaseName;
      // Let layout and paint catch up with the last rendering step.
      await nextFrame();
      await nextFrame();
      if (controller.signal.aborted) return;
      setOutcome(result);
      if (printed.current) return;
      printed.current = true;
      window.print();
    })();
    return () => controller.abort();
  }, [printDocument.fileBaseName]);

  return (
    <main
      className="v2-print-page min-h-[100dvh] min-w-0 overflow-x-hidden bg-answer-paper text-ink"
      data-print-state={outcome ? "ready" : "preparing"}
      data-print-settle={outcome ?? undefined}
      data-testid="chat-print-page"
      ref={rootRef}
    >
      <div className={`v2-print-noprint border-b border-trace-subtle bg-workspace-rail pt-[env(safe-area-inset-top)] ${GUTTER}`}>
        <div className="mx-auto flex min-h-14 w-full max-w-reading flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
          <p className="min-w-0 text-sm text-ink-secondary" role="status" aria-live="polite">
            {outcome
              ? "Ready to print. If no print dialog opened, use the button."
              : "Preparing the conversation for printing…"}
          </p>
          <UiV2Button tone="primary" type="button" onClick={() => window.print()}>
            Print / Save as PDF
          </UiV2Button>
        </div>
      </div>

      <div className={`mx-auto w-full max-w-reading pb-[max(3rem,env(safe-area-inset-bottom))] pt-8 ${GUTTER}`}>
        <header className="v2-print-header border-b border-trace-subtle pb-4">
          <h1 className="break-words text-2xl font-semibold leading-8 text-ink [overflow-wrap:anywhere]">{title}</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Started <time dateTime={printDocument.createdAt}>{displayDate(printDocument.createdAt, hydrated)}</time>
            {" · "}
            Updated <time dateTime={printDocument.updatedAt}>{displayDate(printDocument.updatedAt, hydrated)}</time>
          </p>
        </header>
        {printDocument.turns.length > 0 ? (
          <div className="divide-y divide-trace-subtle" data-testid="chat-print-thread">
            {printDocument.turns.map((turn, index) => <PrintTurn key={index} turn={turn} />)}
          </div>
        ) : (
          <p className="py-8 text-sm text-ink-secondary">This chat has no messages to print.</p>
        )}
      </div>
    </main>
  );
}

/** The same response for a missing chat and one the reader cannot open. */
export function ChatPrintUnavailableV2() {
  return (
    <main className="min-h-[100dvh] min-w-0 bg-answer-paper text-ink" data-testid="chat-print-unavailable">
      <section className={`mx-auto w-full max-w-reading pt-16 ${GUTTER}`} aria-labelledby="chat-print-unavailable-title">
        <h1 className="text-2xl font-semibold leading-8 text-ink" id="chat-print-unavailable-title">Chat not found</h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-ink-secondary">
          This chat does not exist or you do not have access to it.
        </p>
      </section>
    </main>
  );
}
