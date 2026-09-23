"use client";

import { useEffect, useState } from "react";
import { MarkdownEditorV2 } from "@/components/ui-v2/MarkdownEditorV2";
import { renderLocalPromptTemplate, validateIanaTimeZone } from "@/lib/domain/promptTemplates";

const variables = [{ label: "Date", value: "{local_date}" }, { label: "Time", value: "{local_time}" }];

export function InstructionTemplateEditor(props: Readonly<{
  label: string; previewLabel: string; value: string; maxLength: number; disabled?: boolean; onChange(value: string): void;
}>) {
  const [context, setContext] = useState<{ now: Date; timeZone: string } | null>(null);
  useEffect(() => {
    let timeZone = "UTC";
    try { timeZone = validateIanaTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "UTC"; } catch { /* UTC fallback. */ }
    const frame = requestAnimationFrame(() => setContext({ now: new Date(), timeZone }));
    return () => cancelAnimationFrame(frame);
  }, []);
  return <MarkdownEditorV2 {...props} variables={variables}
    previewText={context ? renderLocalPromptTemplate(props.value, { ...context, locale: "en-US" }) : props.value}
    help={`Insert {local_date} or {local_time} where needed. Preview shows an example${context ? ` in ${context.timeZone}` : ""}; each reply uses fresh server time in your time zone.`} />;
}
