import { prisma } from "../prisma";
import { loadProviderAdmissionPlan } from "./admission";

export const providerAdmissionService = Object.freeze({
  load(input: Parameters<typeof loadProviderAdmissionPlan>[1]) {
    return loadProviderAdmissionPlan(prisma, input);
  }
});
