import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PrismaClient } from "@prisma/client";

const LOCAL_DEV_PROFILE_RELATIVE_PATH = ".aiqsa/local-dev-profile/post-seed.ts";

export type LocalDevProfileContext = Readonly<{
  prisma: PrismaClient;
  repositoryRoot: string;
  version: 1;
}>;

type LocalDevProfileModule = Readonly<{
  run?: (context: LocalDevProfileContext) => Promise<void> | void;
}>;

type LocalDevProfileLoaderOptions = Readonly<{
  disabled?: boolean;
  ensureDefaultCredentials?: (prisma: PrismaClient) => Promise<void>;
  loadModule?: (url: string) => Promise<unknown>;
  profilePath?: string;
  repositoryRoot?: string;
}>;

function defaultRepositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

async function defaultModuleLoader(url: string): Promise<unknown> {
  return import(url);
}

function profileModule(value: unknown): LocalDevProfileModule | null {
  return typeof value === "object" && value !== null
    ? value as LocalDevProfileModule
    : null;
}

export async function ensureLocalDevProfileDefaultCredentials(
  prisma: PrismaClient
): Promise<void> {
  const connections = await prisma.providerConnection.findMany({
    orderBy: { id: "asc" },
    select: {
      credentials: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          userAssignments: {
            select: { userId: true },
            take: 1
          }
        },
        where: {
          activeVersion: { is: { revokedAt: null } },
          enabled: true
        }
      },
      defaultCredentialId: true,
      family: true,
      id: true
    }
  });

  for (const connection of connections) {
    if (
      connection.family === "fake" || connection.family === "test" ||
      connection.credentials.length === 0 ||
      connection.credentials.some(({ id }) => id === connection.defaultCredentialId)
    ) {
      continue;
    }
    const assigned = connection.credentials.filter(
      (credential) => (credential.userAssignments?.length ?? 0) > 0
    );
    const candidates = assigned.length === 1 ? assigned : connection.credentials;
    if (candidates.length !== 1) {
      throw new Error("local_dev_profile_default_credential_ambiguous");
    }
    await prisma.providerConnection.update({
      data: { defaultCredentialId: candidates[0]!.id },
      where: { id: connection.id }
    });
  }
}

export async function runOptionalLocalDevProfile(
  prisma: PrismaClient,
  options: LocalDevProfileLoaderOptions = {}
): Promise<"disabled" | "executed" | "missing"> {
  if (options.disabled ?? process.env.AIQSA_LOCAL_DEV_PROFILE_DISABLED === "1") {
    return "disabled";
  }

  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot();
  const profilePath = options.profilePath ?? resolve(
    repositoryRoot,
    LOCAL_DEV_PROFILE_RELATIVE_PATH
  );
  let profileStat;
  try {
    profileStat = await lstat(profilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (!profileStat.isFile()) {
    throw new Error("local_dev_profile_entrypoint_invalid");
  }

  const loaded = profileModule(await (options.loadModule ?? defaultModuleLoader)(
    pathToFileURL(profilePath).href
  ));
  if (typeof loaded?.run !== "function") {
    throw new Error("local_dev_profile_entrypoint_invalid");
  }
  await loaded.run({ prisma, repositoryRoot, version: 1 });
  await (options.ensureDefaultCredentials ?? ensureLocalDevProfileDefaultCredentials)(prisma);
  return "executed";
}
