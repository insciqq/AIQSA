import { scheduledTaskWebhookPath } from "../../contracts/scheduledTasks";
import { getAuthConfig } from "../auth/config";

/**
 * The absolute address a sender posts an automation's events to: the
 * installation's public origin (`AIQSA_APP_BASE_URL`) and the webhook's path.
 * The one place the server builds it, for the token response, the owner's
 * views and the agent's tool results.
 */
export function scheduledTaskWebhookUrl(publicId: string, env: Record<string, string | undefined> = process.env): string {
  return new URL(scheduledTaskWebhookPath(publicId), getAuthConfig(env).appBaseUrl).toString();
}
