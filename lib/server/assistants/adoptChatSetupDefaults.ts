import { prisma } from "../prisma";
import { createPrismaAdoptChatSetup } from "./adoptChatSetup";
import { defaultAssistantHandlerDeps } from "./defaultAssistants";
import type { AdoptChatSetupHandlerDeps } from "./handlers";

export const defaultAdoptChatSetupHandlerDeps: AdoptChatSetupHandlerDeps = {
  ...defaultAssistantHandlerDeps,
  adoptChatSetup: createPrismaAdoptChatSetup(prisma)
};
