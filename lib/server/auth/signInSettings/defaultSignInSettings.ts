import { isExternalGroupSource } from "@/lib/contracts/authSignInMethods";
import { prisma } from "../../prisma";
import { getSecretEncryptionKey } from "../../secrets/envelope";
import { createActiveSignInSettingsCache, decodeActiveSignInSetting, type ActiveSignInSetting } from "./activeSettings";
import { createSignInHealthRecorder } from "./health";
import {
  createPrismaSignInManagementRepository,
  type CurrentIdentitySources
} from "../signInManagement";
import { signInMethodServerRegistry } from "./methods";
import { signInMethodDefinition } from "./registry";
import { createPrismaSignInSettingsRepository } from "./repository";
import { createSignInSettingsService } from "./service";

const ACTIVE_SETTINGS_TTL_MS = 5_000;

export const signInSettingsRepository = createPrismaSignInSettingsRepository({ prisma });

export const activeSignInSettings = createActiveSignInSettingsCache({
  async load() {
    const rows = await signInSettingsRepository.loadEnabled();
    return rows
      .map((row) => decodeActiveSignInSetting(row, getSecretEncryptionKey))
      .filter((setting): setting is ActiveSignInSetting => setting !== null);
  },
  ttlMs: ACTIVE_SETTINGS_TTL_MS
});

export const signInSettingsService = createSignInSettingsService({
  activeSettings: activeSignInSettings,
  encryptionKey: getSecretEncryptionKey,
  registry: signInMethodServerRegistry,
  repository: signInSettingsRepository
});

/** Method handlers record each sign-in's content-free outcome through this. */
export const recordSignInMethodOutcome = createSignInHealthRecorder({ repository: signInSettingsRepository });

/** The password and registration switches the auth handlers enforce. */
export const readSignInPolicy = () => signInSettingsService.readPolicy();

export const signInManagementRepository = createPrismaSignInManagementRepository(prisma);

/** The source each admin-active method binds identities to, from the method's registry hook. */
export async function currentIdentitySources(): Promise<CurrentIdentitySources> {
  const sources: CurrentIdentitySources = {};
  for (const setting of await activeSignInSettings.get()) {
    const identitySource = signInMethodDefinition(signInMethodServerRegistry, setting.method)?.identitySource;
    if (setting.resolved && identitySource && isExternalGroupSource(setting.method)) {
      sources[setting.method] = identitySource(setting.resolved.config);
    }
  }
  return sources;
}
