import { resolveRequestAuth } from "../auth/defaultAuth";
import { prisma } from "../prisma";
import { createProxyHandlers } from "./handlers";
import { createProxyStore } from "./store";

export const handleProxy = createProxyHandlers({ resolveAuth: resolveRequestAuth, store: createProxyStore(prisma) });
