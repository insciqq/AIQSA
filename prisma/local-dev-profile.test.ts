import { resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  ensureLocalDevProfileDefaultCredentials,
  runOptionalLocalDevProfile
} from "./local-dev-profile";

const prisma = {} as PrismaClient;

describe("optional local development profile", () => {
  it("is a silent no-op when the ignored profile is absent", async () => {
    const loadModule = vi.fn();

    await expect(runOptionalLocalDevProfile(prisma, {
      loadModule,
      profilePath: "/tmp/aiqsa-local-profile-that-does-not-exist/post-seed.ts",
      repositoryRoot: "/tmp/aiqsa-local-profile-that-does-not-exist"
    })).resolves.toBe("missing");
    expect(loadModule).not.toHaveBeenCalled();
  });

  it("can be disabled explicitly without probing the profile", async () => {
    const loadModule = vi.fn();

    await expect(runOptionalLocalDevProfile(prisma, {
      disabled: true,
      loadModule,
      profilePath: "/tmp/anything/post-seed.ts"
    })).resolves.toBe("disabled");
    expect(loadModule).not.toHaveBeenCalled();
  });

  it("honors only the exact environment escape hatch", async () => {
    const loadModule = vi.fn();
    vi.stubEnv("AIQSA_LOCAL_DEV_PROFILE_DISABLED", "1");
    try {
      await expect(runOptionalLocalDevProfile(prisma, {
        loadModule,
        profilePath: "/tmp/anything/post-seed.ts"
      })).resolves.toBe("disabled");
      expect(loadModule).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("loads the exact regular-file entrypoint and passes the shared client", async () => {
    const run = vi.fn();
    const ensureDefaultCredentials = vi.fn(async () => {});
    const loadModule = vi.fn(async () => ({ run }));
    const repositoryRoot = process.cwd();
    const profilePath = resolve(repositoryRoot, "prisma/local-dev-profile.ts");

    await expect(runOptionalLocalDevProfile(prisma, {
      ensureDefaultCredentials,
      loadModule,
      profilePath,
      repositoryRoot
    })).resolves.toBe("executed");
    expect(loadModule).toHaveBeenCalledWith(expect.stringMatching(/^file:/u));
    expect(run).toHaveBeenCalledWith({ prisma, repositoryRoot, version: 1 });
    expect(ensureDefaultCredentials).toHaveBeenCalledWith(prisma);
  });

  it("fills every unambiguous active connection default after the profile runs", async () => {
    const update = vi.fn(async () => ({}));
    const profilePrisma = {
      providerConnection: {
        findMany: vi.fn(async () => [
          {
            credentials: [{ id: "credential-openai" }],
            defaultCredentialId: null,
            family: "openai",
            id: "connection-openai"
          },
          {
            credentials: [{ id: "credential-anthropic" }],
            defaultCredentialId: "credential-anthropic",
            family: "anthropic",
            id: "connection-anthropic"
          },
          {
            credentials: [],
            defaultCredentialId: null,
            family: "fake",
            id: "connection-fake"
          }
        ]),
        update
      }
    } as unknown as PrismaClient;

    await ensureLocalDevProfileDefaultCredentials(profilePrisma);

    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({
      data: { defaultCredentialId: "credential-openai" },
      where: { id: "connection-openai" }
    });
  });

  it("fails closed instead of choosing an arbitrary development default", async () => {
    const update = vi.fn();
    const profilePrisma = {
      providerConnection: {
        findMany: vi.fn(async () => [{
          credentials: [{ id: "credential-a" }, { id: "credential-b" }],
          defaultCredentialId: null,
          family: "openai",
          id: "connection-openai"
        }]),
        update
      }
    } as unknown as PrismaClient;

    await expect(ensureLocalDevProfileDefaultCredentials(profilePrisma))
      .rejects.toThrow("local_dev_profile_default_credential_ambiguous");
    expect(update).not.toHaveBeenCalled();
  });

  it("fails closed when the entrypoint does not export run", async () => {
    await expect(runOptionalLocalDevProfile(prisma, {
      loadModule: async () => ({}),
      profilePath: resolve(process.cwd(), "prisma/local-dev-profile.ts")
    })).rejects.toThrow("local_dev_profile_entrypoint_invalid");
  });
});
