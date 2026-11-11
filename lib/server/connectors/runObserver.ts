import type { ConnectorRunStreamEvent } from "./runEvents";

/**
 * Follows one admitted run's events in order: each goes to `publish` first,
 * the answer text so far to `onText` as it grows (and `onReset` when a
 * follow-up replaces it), until the run settles (`done` or `failed`). True
 * when it settled; false when the events ended first (followed past their
 * bound), so the run stays pending for the connector's recovery. Delivering
 * the settled answer is the connector's own step after this.
 */
export async function followConnectorRunEvents(events: AsyncIterable<ConnectorRunStreamEvent>, handlers: Readonly<{
  publish(event: ConnectorRunStreamEvent): Promise<void>;
  onText?(text: string): void;
  onReset?(): void;
}>): Promise<boolean> {
  let text = "";
  for await (const event of events) {
    await handlers.publish(event);
    if (event.type === "answerDelta") {
      text += event.delta;
      handlers.onText?.(text);
    } else if (event.type === "answerReset") {
      text = "";
      handlers.onReset?.();
    } else if (event.type === "done" || event.type === "failed") {
      return true;
    }
  }
  return false;
}
