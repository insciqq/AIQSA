import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";

/** Statuses on which permanent deletion cannot run now, so cleanup archives instead. */
const ARCHIVE_FALLBACK_STATUSES: readonly number[] = [
  409, // a run is still active, or the chat cannot be deleted permanently
  429, // the per-user permanent-deletion budget is spent
  503 // the installation offers no permanent deletion
];

/**
 * Removes a test-owned chat. `DELETE /api/chats/:id` only archives, so the
 * chat is deleted permanently (asynchronously accepted with 202, or already
 * gone with 404) and archived only where permanent deletion is refused for now.
 * `timeout` bounds each request of a cleanup that must not hold up teardown.
 */
export async function deleteOwnedChatPermanently(
  request: APIRequestContext,
  chatId: string,
  options: Readonly<{ timeout?: number }> = {}
): Promise<void> {
  const response = await request.post(`/api/chats/${chatId}/delete-permanently`, {
    data: { alsoForgetOriginMemories: false, confirmationCopyVersion: "memory-confirmation-v1", requestId: randomUUID() },
    maxRetries: 2,
    ...options
  });
  if (ARCHIVE_FALLBACK_STATUSES.includes(response.status())) {
    const archived = await request.delete(`/api/chats/${chatId}`, { maxRetries: 2, ...options });
    expect([200, 204, 404], "the owned chat is archived").toContain(archived.status());
    return;
  }
  expect([202, 404], "the owned chat is cleaned up").toContain(response.status());
}
