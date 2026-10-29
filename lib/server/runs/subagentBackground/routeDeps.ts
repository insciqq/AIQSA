import { resolveRequestAuth } from "../../auth/defaultAuth";
import { prisma } from "../../prisma";
import { getDefaultSubagentBackground } from "./default";
import type { SubagentRouteDeps } from "./handlers";
import { createSubagentViews } from "./views";

/** The sub-agent routes' dependencies: the request session, the installation's views, and the shared control. */
export const defaultSubagentRouteDeps: SubagentRouteDeps = Object.freeze({
  control: {
    stopAll: (input) => getDefaultSubagentBackground().control.stopAll(input),
    stopThread: (input) => getDefaultSubagentBackground().control.stopThread(input)
  },
  resolveAuth: resolveRequestAuth,
  views: createSubagentViews(prisma)
});
