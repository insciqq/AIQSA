/** Field and button classes the sign-in screen and its steps share. */

export const fieldClassName =
  "h-touch w-full rounded-control border border-control-boundary bg-answer-paper px-3.5 text-[15px] text-ink caret-proof outline-none placeholder:text-ink-disabled autofill:bg-answer-paper autofill:text-ink disabled:cursor-not-allowed disabled:border-trace-subtle disabled:text-ink-disabled disabled:opacity-70 focus:border-focus focus:ring-2 focus:ring-focus";

export const invalidFieldClassName =
  "border-critical focus:border-critical";

export const focusRingClassName =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-answer-paper";

export const primaryButtonClassName = `${focusRingClassName} flex min-h-touch w-full items-center justify-center gap-2 rounded-control bg-proof px-4 py-2 text-sm font-semibold text-proof-contrast hover:bg-proof-hover disabled:cursor-not-allowed disabled:opacity-60`;

export const secondaryButtonClassName = `${focusRingClassName} flex min-h-touch items-center justify-center rounded-control px-3 py-2 text-sm font-medium text-ink-secondary hover:bg-control-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled`;

export const formClassName =
  "mt-7 space-y-5 [@media(max-height:32rem)]:!mt-3 [@media(max-height:32rem)]:!space-y-3";
