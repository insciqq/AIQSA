"use client";

import { useEffect, useRef } from "react";
import { UiV2Button } from "@/components/ui-v2";
import { ANSWER_RULES_MAX_LENGTH } from "@/lib/contracts/instructionPresets";
import { VISIBLE_ANSWER_CONTRACT } from "@/lib/domain/promptTemplates";
import { InstructionTemplateEditor } from "./InstructionTemplateEditor";

export function InstructionAnswerRules({ value, onChange, disabled }: Readonly<{
  value: string | null; onChange(value: string | null): void; disabled: boolean;
}>) {
  const section = useRef<HTMLDetailsElement>(null);
  const customize = useRef<HTMLButtonElement>(null);
  const inherited = value === null;
  const previouslyInherited = useRef(inherited);
  useEffect(() => {
    if (previouslyInherited.current !== inherited) {
      if (inherited) customize.current?.focus();
      else section.current?.querySelector("textarea")?.focus();
      previouslyInherited.current = inherited;
    }
  }, [inherited]);
  return <details className="v2-instructions-reminder" ref={section}>
    <summary className="v2-focusable cursor-pointer text-sm font-medium text-ink">Answer rules · {value === null ? "AIQSA standard" : "Custom"}</summary>
    <p className="my-2 text-xs leading-5 text-ink-muted">These rules guide how replies are written. Custom rules replace the standard rules for this preset, from your next reply.</p>
    {value === null ? <>
      <p className="mb-3 whitespace-pre-wrap text-sm leading-6 text-ink-secondary">{VISIBLE_ANSWER_CONTRACT}</p>
      <UiV2Button ref={customize} type="button" disabled={disabled} onClick={() => onChange(VISIBLE_ANSWER_CONTRACT)}>Customize answer rules</UiV2Button>
    </> : <>
      <InstructionTemplateEditor label="Answer rules" previewLabel="Answer rules preview" value={value} onChange={onChange}
        disabled={disabled} maxLength={ANSWER_RULES_MAX_LENGTH} />
      <UiV2Button className="mt-3" type="button" disabled={disabled} onClick={() => onChange(null)}>Use standard answer rules</UiV2Button>
    </>}
  </details>;
}
