"use client";

import { useEffect, useId, useRef, useState } from "react";
import { UiV2Button } from "@/components/ui-v2";
import { writeClipboardText } from "@/components/clipboard/writeClipboardText";
import { decodeMcpCallDetails, type McpCallDetails, type McpCallDisplaySection } from "@/lib/contracts/mcpCallDetails";
import "./mcp-call-details.css";

type Props = Readonly<{
  label: string;
  meta: string;
  reference: Readonly<{ roundIndex: number; ordinal: number }>;
  runId: string;
  status: "cancelled" | "complete" | "error" | "running";
}>;

const stateCopy = {
  pending: "The call has not finished.",
  cancelled: "The call was cancelled.",
  too_large: "The response was too large to be saved.",
  unavailable: "The content is no longer available."
} as const;

function McpTextSectionV2({ name, section, state }: { name: "Request" | "Response"; section: McpCallDisplaySection | null; state: McpCallDetails["responseState"] }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copySequence = useRef(0);
  useEffect(() => {
    copySequence.current += 1;
    return () => { copySequence.current += 1; };
  }, [section?.text]);
  async function copy() {
    if (!section) return;
    const sequence = ++copySequence.current;
    try {
      await writeClipboardText(section.text);
      if (sequence === copySequence.current) setCopyState("copied");
    } catch {
      if (sequence === copySequence.current) setCopyState("failed");
    }
  }
  return <section className="v2-mcp-call-section" aria-label={name} data-state={state}>
    <header>
      <h4>{name}</h4>
      {section ? <UiV2Button onClick={() => void copy()} aria-label={`Copy ${name.toLowerCase()}`}>
        Copy
      </UiV2Button> : null}
    </header>
    {section ? <>
      {section.truncated ? <p className="v2-answer-process-step-meta">Showing part of {section.byteSize.toLocaleString("en-US")} bytes.</p> : null}
      {section.text ? <pre tabIndex={0} aria-label={`${name} text`}>{section.text}</pre>
        : <p className="v2-answer-process-step-meta">No {name.toLowerCase()} content.</p>}
    </> : <p className="v2-answer-process-step-meta">{state === "available" ? "The content is no longer available." : stateCopy[state]}</p>}
    {copyState !== "idle" ? <p role="status" className="v2-answer-process-step-meta">
      {copyState === "copied" ? `${name} copied.` : `Could not copy ${name.toLowerCase()}. Select the text and copy it.`}
    </p> : null}
  </section>;
}

/** One initiator-authorized MCP call, mounted with a key for its exact run/round/ordinal. */
function McpCallDetailsResourceV2({ label, meta, reference, runId, status }: Props) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<McpCallDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // A 404 is the server's single refusal for lost access or removed content;
  // it is final for this row, so it offers no Retry and is not requested again.
  const [gone, setGone] = useState(false);
  const cached = useRef<{ details: McpCallDetails; status: Props["status"]; retry: number } | null>(null);

  useEffect(() => {
    if (!open || gone) return;
    const previous = cached.current;
    if (previous && previous.retry === retry &&
      (previous.status === status || previous.details.responseState !== "pending")) return;
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError(false);
      try {
        const response = await fetch(`/api/model-runs/${encodeURIComponent(runId)}/mcp-calls/${reference.roundIndex}/${reference.ordinal}`, {
          cache: "no-store", signal: controller.signal
        });
        if (response.status === 404) {
          if (!controller.signal.aborted) setGone(true);
          return;
        }
        if (!response.ok) throw new Error("mcp_details_unavailable");
        const details = decodeMcpCallDetails(await response.json());
        if (!details) throw new Error("mcp_details_invalid");
        if (controller.signal.aborted) return;
        cached.current = { details, retry, status };
        setResult(details);
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [gone, open, reference.ordinal, reference.roundIndex, retry, runId, status]);

  const pending = result?.responseState === "pending";
  return <div className="v2-mcp-call" data-testid="mcp-call-row">
    <button className="v2-mcp-call-toggle v2-focusable" type="button" aria-expanded={open}
      aria-controls={panelId} onClick={() => setOpen(value => !value)}>
      <span className="v2-mcp-call-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
      <span className="v2-answer-process-step-name">{label}</span>
      <span className="v2-answer-process-step-meta">{meta}</span>
      <span className="v2-sr-only">MCP call details</span>
    </button>
    {open ? <div className="v2-mcp-call-details" id={panelId} data-testid="mcp-call-details" aria-busy={loading || undefined}>
      {loading ? <p role="status">Loading call details…</p> : null}
      {gone && !loading ? <p className="v2-answer-process-step-meta">{stateCopy.unavailable}</p> : null}
      {error ? <div role="alert">
        <p>Call details could not be loaded.</p>
        <UiV2Button onClick={() => setRetry(value => value + 1)}>Retry call details</UiV2Button>
      </div> : null}
      {!loading && !error && !gone && result ? <>
        <McpTextSectionV2 key={`request:${retry}:${status}`} name="Request" section={result.request} state={result.requestState} />
        <McpTextSectionV2 key={`response:${retry}:${status}`} name="Response" section={result.response} state={result.responseState} />
        {result.isError ? <p className="v2-answer-process-step-meta">The tool reported an error.</p> : null}
        {result.unsupportedContentTypes.length ? <p className="v2-answer-process-step-meta">
          Content not included: {result.unsupportedContentTypes.join(", ")}.
        </p> : null}
        {pending ? <UiV2Button onClick={() => setRetry(value => value + 1)}>Refresh call details</UiV2Button> : null}
      </> : null}
    </div> : null}
  </div>;
}

export function McpCallDetailsV2(props: Props) {
  return <McpCallDetailsResourceV2 key={`${props.runId}:${props.reference.roundIndex}:${props.reference.ordinal}`} {...props} />;
}
