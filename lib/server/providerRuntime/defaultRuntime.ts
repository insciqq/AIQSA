import { isTestModeAllowedEnv } from "../auth/csrf";
import { prisma } from "../prisma";
import { createProviderSafeFetch } from "../providers/providerSafeFetch";
import {
  createPrismaProviderRuntimeStore,
  createProviderRuntimeResolver
} from "./runtimeResolver";

export const providerRuntimeResolver = createProviderRuntimeResolver({
  allowFake: isTestModeAllowedEnv(process.env),
  createFetch: (snapshot) => createProviderSafeFetch({
    configuration: snapshot.connection
  }),
  store: createPrismaProviderRuntimeStore(prisma)
});
