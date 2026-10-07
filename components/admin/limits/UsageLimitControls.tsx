"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import { fieldLabelClass, helpTextClass } from "@/components/admin/users/usersPrimitives";
import { useEffect, useState, type RefObject } from "react";

export type UsageMeterTone = "near" | "ok" | "reached";

const meterTone: Record<UsageMeterTone, string> = {
  near: "bg-caution",
  ok: "bg-proof",
  reached: "bg-critical"
};

/** A share of a limit; the state is also spelled out next to it, never by colour alone. */
export function UsageMeter({
  label,
  percent,
  tone,
  valueText
}: Readonly<{ label: string; percent: number; tone: UsageMeterTone; valueText: string }>) {
  const shown = Math.min(100, Math.max(0, percent));
  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={shown}
      aria-valuetext={valueText}
      className="h-1.5 w-full min-w-0 overflow-hidden rounded-pill bg-trace-strong"
      data-tone={tone}
      role="meter"
    >
      <span className={`block h-full rounded-pill ${meterTone[tone]}`} style={{ width: `${shown}%` }} />
    </div>
  );
}

/** An unset limit: a quiet dash that still reads as words. */
export function NotSet({ text = "Not set" }: Readonly<{ text?: string }>) {
  return (
    <>
      <span aria-hidden="true" className="text-ink-muted">—</span>
      <span className="sr-only">{text}</span>
    </>
  );
}

/** One limit field: empty means not set; USD fields take a `$` prefix. */
export function UsageLimitInput({
  disabled,
  error,
  help,
  id,
  kind,
  label,
  onChange,
  placeholder,
  value
}: Readonly<{
  disabled: boolean;
  error?: string;
  help?: string;
  id: string;
  kind: "count" | "usd";
  label: string;
  onChange(value: string): void;
  placeholder: string;
  value: string;
}>) {
  const errorId = `${id}-error`;
  const helpId = `${id}-help`;
  return (
    <div className="min-w-0">
      <label className={fieldLabelClass} htmlFor={id}>{label}</label>
      <div className="relative min-w-0">
        {kind === "usd" ? (
          <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-ink-muted">$</span>
        ) : null}
        <input
          aria-describedby={error ? errorId : help ? helpId : undefined}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          className={`${inputClass} font-mono tabular-nums ${kind === "usd" ? "pl-7" : ""}`}
          disabled={disabled}
          id={id}
          inputMode={kind === "usd" ? "decimal" : "numeric"}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder={placeholder}
          spellCheck={false}
          type="text"
          value={value}
        />
      </div>
      {error ? (
        <p className="mt-1.5 text-xs leading-5 text-critical" id={errorId}>{error}</p>
      ) : help ? (
        <p className={helpTextClass} id={helpId}>{help}</p>
      ) : null}
    </div>
  );
}

/**
 * After a rejected submit, moves focus to the first field marked invalid once
 * the errors have rendered. Call the returned function on each rejection.
 */
export function useFocusFirstInvalid(scope: RefObject<HTMLElement | null>): () => void {
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (attempt > 0) scope.current?.querySelector<HTMLInputElement>("input[aria-invalid='true']")?.focus();
  }, [attempt, scope]);
  return () => setAttempt((value) => value + 1);
}
