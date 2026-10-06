"use client";

import { useEffect, useRef } from "react";
import { UiV2Button } from "@/components/ui-v2";
import { classifyClientError, clientErrorReporter, type ClientErrorReporter } from "@/lib/browser/clientErrorReporter";

export type AppErrorScreenProps = Readonly<{
  error: Error & { digest?: string };
  /** Next's re-render of the failed segment. */
  reset: () => void;
  /** Next's re-fetch and re-render; preferred when the framework provides it. */
  retry?: () => void;
  reporter?: ClientErrorReporter;
  reload?: () => void;
}>;

const SAFE_DIGEST = /^[A-Za-z0-9_-]{1,64}$/u;

function reloadPage() {
  window.location.reload();
}

/**
 * The recoverable crash screen of `app/error.tsx` and `app/global-error.tsx`.
 * It never renders the error's message or stack; Next's digest is an opaque
 * reference that matches the server log.
 */
export function AppErrorScreen({ error, reset, retry, reporter = clientErrorReporter, reload = reloadPage }: AppErrorScreenProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const kind = classifyClientError(error, "render");
  const stale = kind === "chunk_load";
  const digest = typeof error.digest === "string" && SAFE_DIGEST.test(error.digest) ? error.digest : null;

  useEffect(() => {
    reporter.report(kind, error);
  }, [error, kind, reporter]);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <main
      className="min-h-[100dvh] min-w-0 overflow-x-hidden bg-answer-paper text-ink"
      data-testid="app-error-screen"
    >
      <section
        aria-labelledby="app-error-title"
        className="mx-auto w-full max-w-reading pb-[max(4rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-16 sm:pb-24 sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))] sm:pt-24"
      >
        <h1
          className="text-2xl font-semibold leading-8 text-ink outline-none"
          id="app-error-title"
          ref={headingRef}
          tabIndex={-1}
        >
          {stale ? "AIQSA was updated" : "Something went wrong"}
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-ink-secondary">
          {stale
            ? "This page needs files from a newer version. Reload the page to continue."
            : "This page stopped working because of an unexpected error. Try again, or reload the page."}
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          {stale ? null : (
            <UiV2Button onClick={() => (retry ?? reset)()} tone="primary" type="button">
              Try again
            </UiV2Button>
          )}
          <UiV2Button onClick={reload} tone={stale ? "primary" : "ghost"} type="button">
            Reload
          </UiV2Button>
        </div>
        {digest ? (
          <p className="mt-6 text-xs leading-5 text-ink-muted">
            Reference: <span className="font-mono">{digest}</span>
          </p>
        ) : null}
      </section>
    </main>
  );
}
