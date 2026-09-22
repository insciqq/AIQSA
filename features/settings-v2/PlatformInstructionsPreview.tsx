"use client";

import { useEffect, useRef, useState } from "react";
import { UiV2Button } from "@/components/ui-v2";
import type { InstructionPreview } from "@/lib/contracts/instructionPreview";
import { requestInstructionPreview } from "./instructionPresetsApi";

type PreviewState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: InstructionPreview };

export function PlatformInstructionsPreview({ onClose }: Readonly<{ onClose?(): void }>) {
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timeZone: string | undefined;
    try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* Server uses UTC. */ }
    void requestInstructionPreview(timeZone, controller.signal).then(data => {
      if (!controller.signal.aborted) setState({ status: "ready", data });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ status: "error" });
    });
    return () => controller.abort();
  }, [attempt]);

  return <section aria-label="AIQSA default instructions preview" className="min-w-0 space-y-4">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 ref={heading} tabIndex={-1} className="v2-focusable text-sm font-semibold text-ink">AIQSA default instructions</h3>
        <p className="mt-1 text-xs text-ink-muted">Read-only · Platform instructions</p>
      </div>
      {onClose ? <UiV2Button type="button" onClick={onClose}>Close preview</UiV2Button> : null}
    </div>
    <p className="text-xs leading-5 text-ink-muted">Personal presets add to the system baseline. Assistants use their own system instructions and keep the shared visible answer contract. Tools, Skills, Memory and other context can add instructions for a reply; this preview shows only the platform rules below.</p>
    {state.status === "loading" ? <p className="py-4 text-sm text-ink-muted" role="status">Loading built-in instructions…</p> : null}
    {state.status === "error" ? <div className="space-y-2 text-sm" role="alert">
      <p className="text-critical">The built-in instructions are unavailable. Try again.</p>
      <UiV2Button type="button" onClick={() => { setState({ status: "loading" }); setAttempt(value => value + 1); }}>Retry</UiV2Button>
    </div> : null}
    {state.status === "ready" ? <>
      <div className="min-w-0 space-y-2">
        <h4 className="text-xs font-semibold text-ink-muted">System baseline</h4>
        <pre className="whitespace-pre-wrap rounded-lg border border-trace-subtle bg-answer-paper p-3 font-sans text-sm leading-6 text-ink [overflow-wrap:anywhere]">{state.data.baseline.renderedSystemPrompt}</pre>
        <p className="text-xs leading-5 text-ink-muted">Generated <time dateTime={state.data.generatedAt}>{new Date(state.data.generatedAt).toLocaleString()}</time>. Time zone used: {state.data.baseline.timeZone}{state.data.baseline.timeZoneSource === "utc_fallback" ? " (fallback)" : ""}. The next reply uses a fresh server time.</p>
      </div>
      <div className="min-w-0 space-y-2">
        <h4 className="text-xs font-semibold text-ink-muted">Visible answer contract</h4>
        <pre className="whitespace-pre-wrap rounded-lg border border-trace-subtle bg-answer-paper p-3 font-sans text-sm leading-6 text-ink [overflow-wrap:anywhere]">{state.data.visibleAnswerContract}</pre>
      </div>
    </> : null}
  </section>;
}
