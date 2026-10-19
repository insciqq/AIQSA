/**
 * Whether Settings → Connections shows the Telegram block for this user:
 * the bot is on and open to them, or they still hold a link whose access is
 * off or whose bot changed (so they can see the reason and disconnect).
 *
 * Seam for Telegram Connect: answers false until the server access resolver
 * (`resolveTelegramAccess`, PRD D-04) is wired here.
 */
export async function loadViewerTelegramAvailable(userId: string): Promise<boolean> {
  void userId;
  return false;
}
