import { resolveRequestAuth } from "../auth/defaultAuth";
import { prisma } from "../prisma";
import { createMemoryNoteHandlers } from "./handlers";
import { createMemoryNoteService } from "./service";

/** The memory note's service and Settings routes with their production dependencies. */
export const defaultMemoryNoteService = createMemoryNoteService({ db: prisma });

export const defaultMemoryNoteHandlers = createMemoryNoteHandlers({ resolveAuth: resolveRequestAuth, service: defaultMemoryNoteService });
