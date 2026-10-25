import { prisma } from "../prisma";
import { kickScheduledTaskRunner } from "./runnerKick";
import { createScheduledTaskWebhookIntake } from "./webhookIntake";
import { createPrismaScheduledTaskWebhookIntakeStore } from "./webhookStore";

/** The public webhook endpoint's handler: its store and the runner's wake-up, nothing of the owner API. */
export const defaultScheduledTaskWebhookIntake = createScheduledTaskWebhookIntake({
  kick: kickScheduledTaskRunner,
  store: createPrismaScheduledTaskWebhookIntakeStore(prisma)
});
