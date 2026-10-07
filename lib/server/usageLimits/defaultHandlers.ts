import { resolveRequestAuth } from "../auth/defaultAuth";
import { usageLimitsRepository } from "./defaultRepository";
import { createAdminUsageLimitsHandlers } from "./handlers";

export const adminUsageLimitsHandlers = createAdminUsageLimitsHandlers({
  repository: usageLimitsRepository,
  resolveAuth: resolveRequestAuth
});
