import type { ProviderRunRequest } from "./types";

export const RESPONSE_REMINDER_PREVIEW = "[response reminder omitted]";
export const PERSONAL_INSTRUCTIONS_PREVIEW = "[personal instructions omitted]";

/** The reminder is the final block of this run's original user input. Tool
 * continuations reuse that input; neither the DAG nor request.content changes. */
export function withResponseReminder<T>(request: ProviderRunRequest, content: T[], textBlock: (text: string) => T, preview?: boolean): T[];
export function withResponseReminder<T>(request: ProviderRunRequest, content: string | T[], textBlock: (text: string) => T, preview?: boolean): string | T[];
export function withResponseReminder<T>(request: ProviderRunRequest, content: string | T[], textBlock: (text: string) => T, preview = false): string | T[] {
  const reminder = request.prompt.responseReminder;
  if (!reminder) return content;
  return [...(typeof content === "string" ? [textBlock(content)] : content), textBlock(preview ? RESPONSE_REMINDER_PREVIEW : reminder)];
}
