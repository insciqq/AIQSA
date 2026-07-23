import { Prisma, type PrismaClient } from "@prisma/client";
import { defaultProviderModels, defaultSearchStrategies } from "@/lib/domain/catalog";
import { LOCAL_ORDINARY_USERS } from "@/prisma/local-seed-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  bootstrapInstallationDatabase,
  InstallationBootstrapError,
  installationBootstrapInputFromEnv,
  validateInstallationBootstrapInput,
  type InstallationBootstrapInput
} from "./installationBootstrap";

const USER_ID = "7e6db97e-d8a9-4e94-b03c-6df0f1df44a1";
const NOW = new Date("2026-07-14T16:00:00.000Z");

const baseInput: InstallationBootstrapInput = {
  displayName: "Initial Admin",
  email: "admin@example.com",
  password: "correct horse battery staple"
};

type AdoptedState = {
  identity: {
    emailVerifiedAt: Date | null;
    normalizedEmail: string;
    passwordHash: string | null;
    providerAccountId: string;
    userId: string;
  } | null;
  user: {
    email: string | null;
    id: string;
  } | null;
};

type BootstrapTransactionFixture = ReturnType<typeof createBootstrapTransaction>;

function createBootstrapTransaction(input: {
  adopted?: Partial<AdoptedState>;
  nonempty: boolean;
}) {
  const events: string[] = [];
  let rawQueryIndex = 0;
  const record = <T>(event: string, result: T) =>
    vi.fn(async (_input: unknown) => {
      events.push(event);
      return result;
    });
  const user = input.adopted?.user ?? null;
  const identity = input.adopted?.identity ?? null;
  const queryRaw = vi.fn(async () => {
    rawQueryIndex += 1;
    const event = rawQueryIndex === 1 ? "lock" : "count";

    events.push(event);
    return rawQueryIndex === 1
      ? [{ lock: "locked" }]
      : [{ nonempty: input.nonempty ? "true" : "false" }];
  });
  const spies = {
    accessGrantCreateMany: record("accessGrant.createMany", { count: 0 }),
    authIdentityCreate: record("authIdentity.create", { id: "identity-id" }),
    authIdentityFindFirst: record("authIdentity.findFirst", identity),
    folderCreate: record("folder.create", { id: "folder-id" }),
    groupCreate: record("group.create", { id: "group-id" }),
    promptPresetCreate: record("promptPreset.create", { id: "prompt-id" }),
    providerModelUpsert: record("providerModel.upsert", { id: "model-id" }),
    searchStrategyUpsert: record("searchStrategy.upsert", { id: "strategy-id" }),
    userCreate: record("user.create", { id: USER_ID }),
    userFindUnique: record("user.findUnique", user),
    userGroupCreate: record("userGroup.create", {}),
    userSettingsCreate: record("userSettings.create", {})
  };
  const tx = {
    $queryRaw: queryRaw,
    accessGrant: {
      createMany: spies.accessGrantCreateMany
    },
    authIdentity: {
      create: spies.authIdentityCreate,
      findFirst: spies.authIdentityFindFirst
    },
    folder: {
      create: spies.folderCreate
    },
    group: {
      create: spies.groupCreate
    },
    promptPreset: {
      create: spies.promptPresetCreate
    },
    providerModel: {
      upsert: spies.providerModelUpsert
    },
    searchStrategy: {
      upsert: spies.searchStrategyUpsert
    },
    user: {
      create: spies.userCreate,
      findUnique: spies.userFindUnique
    },
    userGroup: {
      create: spies.userGroupCreate
    },
    userSettings: {
      create: spies.userSettingsCreate
    }
  } as unknown as Prisma.TransactionClient;

  return {
    events,
    queryRaw,
    spies,
    tx
  };
}

function createBootstrapClient(fixture: BootstrapTransactionFixture) {
  const transaction = vi.fn(
    async (
      operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
      _options: unknown
    ) => operation(fixture.tx)
  );

  return {
    prisma: {
      $transaction: transaction
    } as unknown as PrismaClient,
    transaction
  };
}

function expectBootstrapError(error: unknown, code: InstallationBootstrapError["code"]): void {
  expect(error).toBeInstanceOf(InstallationBootstrapError);
  expect((error as InstallationBootstrapError).code).toBe(code);
}

function allFoundationMutationSpies(fixture: BootstrapTransactionFixture) {
  return [
    fixture.spies.userCreate,
    fixture.spies.authIdentityCreate,
    fixture.spies.groupCreate,
    fixture.spies.userGroupCreate,
    fixture.spies.folderCreate,
    fixture.spies.promptPresetCreate,
    fixture.spies.userSettingsCreate,
    fixture.spies.accessGrantCreateMany
  ];
}

describe("installation bootstrap", () => {
  it("reads explicit identity inputs while allowing the password to be removed after adoption", () => {
    expect(
      installationBootstrapInputFromEnv({
        AIQSA_INITIAL_ADMIN_EMAIL: " ADMIN@example.com ",
      })
    ).toEqual({
      displayName: "Administrator",
      email: "ADMIN@example.com"
    });

    expect(
      installationBootstrapInputFromEnv({
        AIQSA_INITIAL_ADMIN_DISPLAY_NAME: " Initial Admin ",
        AIQSA_INITIAL_ADMIN_EMAIL: " ADMIN@example.com ",
        AIQSA_INITIAL_ADMIN_USER_ID: USER_ID
      })
    ).toEqual({
      displayName: "Initial Admin",
      email: "ADMIN@example.com",
      userId: USER_ID
    });

    expect(() =>
      installationBootstrapInputFromEnv({
        AIQSA_INITIAL_ADMIN_USER_ID: USER_ID
      })
    ).toThrowError(InstallationBootstrapError);
  });

  it("normalizes email and rejects invalid email, password, display-name, and user-id inputs", () => {
    expect(
      validateInstallationBootstrapInput({
        ...baseInput,
        displayName: " Initial Admin ",
        email: " ADMIN@Example.com "
      })
    ).toMatchObject({
      displayName: "Initial Admin",
      email: "admin@example.com"
    });

    const invalidInputs: Array<{
      code: InstallationBootstrapError["code"];
      input: InstallationBootstrapInput;
    }> = [
      { code: "email_invalid", input: { ...baseInput, email: "not-an-email" } },
      { code: "password_too_short", input: { ...baseInput, password: "short" } },
      { code: "display_name_invalid", input: { ...baseInput, displayName: " " } },
      { code: "user_id_invalid", input: { ...baseInput, userId: "operator" } }
    ];

    for (const invalid of invalidInputs) {
      try {
        validateInstallationBootstrapInput(invalid.input);
        throw new Error("Expected input validation to fail.");
      } catch (error) {
        expectBootstrapError(error, invalid.code);
      }
    }
  });

  it("creates only the catalog and initial admin foundation on a fresh database", async () => {
    const fixture = createBootstrapTransaction({ nonempty: false });
    const { prisma, transaction } = createBootstrapClient(fixture);
    const hashPassword = vi.fn(async () => "hashed-initial-password");

    await expect(
      bootstrapInstallationDatabase(prisma, baseInput, {
        hashPassword,
        now: () => NOW,
        randomUUID: () => USER_ID
      })
    ).resolves.toEqual({
      catalogModelCount: defaultProviderModels.length,
      catalogSearchStrategyCount: defaultSearchStrategies.length,
      status: "created"
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0]?.[1]).toMatchObject({
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    });
    expect(fixture.events.slice(0, 3)).toEqual([
      "lock",
      "count",
      "authIdentity.findFirst"
    ]);
    expect(hashPassword).toHaveBeenCalledOnce();
    expect(hashPassword).toHaveBeenCalledWith(baseInput.password);
    expect(fixture.spies.userCreate).toHaveBeenCalledOnce();
    expect(fixture.spies.authIdentityCreate).toHaveBeenCalledOnce();
    expect(fixture.spies.userCreate).toHaveBeenCalledWith({
      data: {
        displayName: "Initial Admin",
        email: "admin@example.com",
        id: USER_ID,
        role: "admin",
        status: "active"
      }
    });
    expect(fixture.spies.authIdentityCreate).toHaveBeenCalledWith({
      data: {
        emailVerifiedAt: NOW,
        normalizedEmail: "admin@example.com",
        passwordHash: "hashed-initial-password",
        provider: "password",
        providerAccountId: "admin@example.com",
        userId: USER_ID
      }
    });
    expect(fixture.spies.folderCreate).not.toHaveBeenCalled();
    expect(fixture.spies.promptPresetCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        isDefault: true,
        name: "Helpful Assistant",
        userId: USER_ID
      })
    });
    expect(fixture.spies.userSettingsCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        defaultFolderId: null,
        defaultModelId: "gpt-5.5",
        defaultPromptPresetId: "prompt-id",
        defaultProvider: "openai",
        userId: USER_ID
      })
    });
    expect(fixture.spies.providerModelUpsert).toHaveBeenCalledTimes(defaultProviderModels.length);
    expect(fixture.spies.searchStrategyUpsert).toHaveBeenCalledTimes(defaultSearchStrategies.length);

    const productionFoundationCalls = JSON.stringify({
      identities: fixture.spies.authIdentityCreate.mock.calls,
      users: fixture.spies.userCreate.mock.calls
    });
    for (const ordinaryFixture of LOCAL_ORDINARY_USERS) {
      expect(productionFoundationCalls).not.toContain(ordinaryFixture.id);
      expect(productionFoundationCalls).not.toContain(ordinaryFixture.email);
      expect(productionFoundationCalls).not.toContain(ordinaryFixture.password);
    }

    const grantCall = fixture.spies.accessGrantCreateMany.mock.calls[0]?.[0] as
      | { data: Array<Record<string, unknown>> }
      | undefined;
    const grantData = grantCall?.data;

    expect(grantData).toBeDefined();
    expect(grantData).toHaveLength(
      defaultProviderModels.filter((model) => model.provider !== "fake").length +
        defaultSearchStrategies.filter((strategy) => strategy.strategyId !== "search-disabled").length
    );
    expect(grantData).not.toContainEqual(expect.objectContaining({ provider: "fake" }));
    expect(grantData).not.toContainEqual(expect.objectContaining({ searchStrategy: "search-disabled" }));
  });

  it("fails a fresh database without a password before catalog or foundation mutation", async () => {
    const fixture = createBootstrapTransaction({ nonempty: false });
    const { prisma } = createBootstrapClient(fixture);
    const hashPassword = vi.fn(async () => "unused");

    try {
      await bootstrapInstallationDatabase(
        prisma,
        {
          ...baseInput,
          password: undefined
        },
        { hashPassword }
      );
      throw new Error("Expected bootstrap to fail.");
    } catch (error) {
      expectBootstrapError(error, "fresh_database_password_required");
    }

    expect(hashPassword).not.toHaveBeenCalled();
    expect(fixture.spies.providerModelUpsert).not.toHaveBeenCalled();
    expect(fixture.spies.searchStrategyUpsert).not.toHaveBeenCalled();
    for (const mutation of allFoundationMutationSpies(fixture)) {
      expect(mutation).not.toHaveBeenCalled();
    }
  });

  it("fails a nonempty unadopted database before any mutation", async () => {
    const fixture = createBootstrapTransaction({ nonempty: true });
    const { prisma } = createBootstrapClient(fixture);
    const hashPassword = vi.fn(async () => "unused");

    try {
      await bootstrapInstallationDatabase(prisma, baseInput, { hashPassword });
      throw new Error("Expected bootstrap to fail.");
    } catch (error) {
      expectBootstrapError(error, "unsafe_nonempty_database");
    }

    expect(hashPassword).not.toHaveBeenCalled();
    expect(fixture.spies.providerModelUpsert).not.toHaveBeenCalled();
    expect(fixture.spies.searchStrategyUpsert).not.toHaveBeenCalled();
    for (const mutation of allFoundationMutationSpies(fixture)) {
      expect(mutation).not.toHaveBeenCalled();
    }
  });

  it("refreshes only code-owned metadata for the exact adopted identity", async () => {
    const fixture = createBootstrapTransaction({
      adopted: {
        identity: {
          emailVerifiedAt: NOW,
          normalizedEmail: "admin@example.com",
          passwordHash: "operator-owned-password-hash",
          providerAccountId: "admin@example.com",
          userId: USER_ID
        },
        user: {
          email: "ADMIN@example.com",
          id: USER_ID
        }
      },
      nonempty: true
    });
    const { prisma } = createBootstrapClient(fixture);
    const hashPassword = vi.fn(async () => "must-not-be-used");

    await expect(
      bootstrapInstallationDatabase(
        prisma,
        baseInput,
        { hashPassword }
      )
    ).resolves.toMatchObject({
      status: "already_adopted"
    });

    expect(hashPassword).not.toHaveBeenCalled();
    expect(fixture.spies.providerModelUpsert).toHaveBeenCalledTimes(defaultProviderModels.length);
    expect(fixture.spies.searchStrategyUpsert).toHaveBeenCalledTimes(defaultSearchStrategies.length);
    for (const [args] of fixture.spies.providerModelUpsert.mock.calls) {
      expect(args).toEqual(expect.objectContaining({ update: expect.any(Object) }));
      expect((args as { update: object }).update).not.toHaveProperty("enabled");
    }
    for (const [args] of fixture.spies.searchStrategyUpsert.mock.calls) {
      expect(args).toEqual(expect.objectContaining({ update: expect.any(Object) }));
      expect((args as { update: object }).update).not.toHaveProperty("enabled");
    }
    for (const mutation of allFoundationMutationSpies(fixture)) {
      expect(mutation).not.toHaveBeenCalled();
    }
  });

  it("allows the adopted rerun after the plaintext bootstrap password is removed", async () => {
    const fixture = createBootstrapTransaction({
      adopted: {
        identity: {
          emailVerifiedAt: NOW,
          normalizedEmail: "admin@example.com",
          passwordHash: "operator-owned-password-hash",
          providerAccountId: "admin@example.com",
          userId: USER_ID
        },
        user: {
          email: "admin@example.com",
          id: USER_ID
        }
      },
      nonempty: true
    });
    const { prisma } = createBootstrapClient(fixture);

    await expect(
      bootstrapInstallationDatabase(prisma, {
        ...baseInput,
        password: undefined
      })
    ).resolves.toMatchObject({
      status: "already_adopted"
    });
  });

  it("rejects an adopted identity when an explicit user id does not match", async () => {
    const fixture = createBootstrapTransaction({
      adopted: {
        identity: {
          emailVerifiedAt: NOW,
          normalizedEmail: "admin@example.com",
          passwordHash: "operator-owned-password-hash",
          providerAccountId: "admin@example.com",
          userId: USER_ID
        },
        user: {
          email: "admin@example.com",
          id: USER_ID
        }
      },
      nonempty: true
    });
    const { prisma } = createBootstrapClient(fixture);

    await expect(
      bootstrapInstallationDatabase(prisma, {
        ...baseInput,
        userId: "c80db0fc-87b9-4b82-96a3-7e1772072485"
      })
    ).rejects.toMatchObject({
      code: "unsafe_nonempty_database"
    });
  });

  it("does not accept an unverified or passwordless lookalike identity", async () => {
    const fixture = createBootstrapTransaction({
      adopted: {
        identity: {
          emailVerifiedAt: null,
          normalizedEmail: "admin@example.com",
          passwordHash: null,
          providerAccountId: "admin@example.com",
          userId: USER_ID
        },
        user: {
          email: "admin@example.com",
          id: USER_ID
        }
      },
      nonempty: true
    });
    const { prisma } = createBootstrapClient(fixture);

    await expect(bootstrapInstallationDatabase(prisma, baseInput)).rejects.toMatchObject({
      code: "unsafe_nonempty_database"
    });
    expect(fixture.spies.providerModelUpsert).not.toHaveBeenCalled();
    for (const mutation of allFoundationMutationSpies(fixture)) {
      expect(mutation).not.toHaveBeenCalled();
    }
  });
});
