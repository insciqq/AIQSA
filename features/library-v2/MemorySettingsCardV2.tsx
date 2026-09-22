"use client";

import { useId, useState, type ReactNode } from "react";
import { UiV2Icon } from "@/components/ui-v2";

export function MemorySettingsCardV2({ children, status }: Readonly<{ children: ReactNode; status: string }>) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  return <aside className="v2-memory-settings-card" aria-label="How Memory works">
    <h2>How Memory works</h2>
    <button type="button" className="v2-memory-settings-toggle v2-focusable" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>
      <span>How Memory works<small>{status}</small></span><UiV2Icon name="chevron-down" />
    </button>
    <div id={contentId} className="v2-memory-settings-body" data-expanded={expanded || undefined}
      onFocusCapture={() => setExpanded(true)}>{children}</div>
  </aside>;
}
