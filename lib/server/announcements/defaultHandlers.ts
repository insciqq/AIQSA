import { resolveRequestAuth } from "../auth/defaultAuth";
import { prisma } from "../prisma";
import { createAnnouncementsHandlers } from "./handlers";
import { createAnnouncementsRepository } from "./repository";

export const handleAnnouncement = createAnnouncementsHandlers({
  resolveAuth: resolveRequestAuth, repository: createAnnouncementsRepository(prisma)
});
