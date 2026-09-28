import { resolveRequestAuth } from "../auth/defaultAuth";
import { prisma } from "../prisma";
import { defaultAssistantRepository } from "./defaultAssistants";
import { createListedAssistantService } from "./listedAssistants";
import { createAssistantListingHandlers } from "./listingHandlers";
import { createAssistantListingService } from "./listingRequests";

export const defaultAssistantListingService = createAssistantListingService(prisma);
export const defaultListedAssistantService = createListedAssistantService(prisma, defaultAssistantRepository);
export const defaultAssistantListingHandlers = createAssistantListingHandlers({
  resolveAuth: resolveRequestAuth, requests: defaultAssistantListingService, listed: defaultListedAssistantService
});
