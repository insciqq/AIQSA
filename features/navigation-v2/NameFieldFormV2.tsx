"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { UiV2IconButton } from "@/components/ui-v2";
import type { NameSaveResult } from "@/components/app-shell/types";

export type NameSaveOutcome = NameSaveResult | undefined;

/**
 * Inline chat-title / folder-name form. The typed value stays until the owner
 * reports a stored save (`ok: true`); a server name-contract rejection renders
 * at this field, never as an apparently successful save.
 */
export function NameFieldFormV2({
  cancelLabel,
  className,
  inputLabel,
  maxLength,
  onCancel,
  onChange,
  onEscape,
  onSave,
  onSaved,
  placeholder,
  saveLabel,
  value
}: Readonly<{
  cancelLabel: string;
  className: string;
  inputLabel: string;
  maxLength: number;
  onCancel?(): void;
  onChange(value: string): void;
  onEscape?(event: KeyboardEvent<HTMLInputElement>): void;
  onSave(): Promise<NameSaveOutcome> | NameSaveOutcome;
  onSaved?(): void;
  placeholder?: string;
  saveLabel: string;
  value: string;
}>) {
  const [fieldError, setFieldError] = useState<string | null>(null);
  const pending = useRef(false);
  const errorId = useId();
  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        if (!value.trim() || pending.current) return;
        pending.current = true;
        void Promise.resolve(onSave())
          .then((result) => {
            if (result?.ok === true) onSaved?.();
            else setFieldError(result?.ok === false ? result.fieldError : null);
          }, () => undefined)
          .finally(() => {
            pending.current = false;
          });
      }}
    >
      <input
        autoFocus
        aria-describedby={fieldError ? errorId : undefined}
        aria-invalid={fieldError ? true : undefined}
        aria-label={inputLabel}
        maxLength={maxLength}
        placeholder={placeholder}
        value={value}
        onChange={(event) => {
          setFieldError(null);
          onChange(event.target.value);
        }}
        onKeyDown={onEscape
          ? (event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onEscape(event);
              }
            }
          : undefined}
      />
      <UiV2IconButton icon="check" label={saveLabel} type="submit" />
      <UiV2IconButton icon="close" label={cancelLabel} onClick={onCancel} />
      {fieldError ? (
        <p className="v2-name-field-error" id={errorId} role="alert">{fieldError}</p>
      ) : null}
    </form>
  );
}
