import { Prisma, type PrismaClient } from "@prisma/client";
import { defaultSearchStrategies } from "@/lib/domain/catalog";
import { providerConnectionTemplates } from "@/lib/domain/providerTemplates";
import { automaticRerankerRoutePresets } from "@/lib/domain/rerankerModels";
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
const bootstrapSearchStrategies = defaultSearchStrategies.filter(
  (strategy) => strategy.kind !== "perplexity_tool_search"
);
const bootstrapSearchRoutes = bootstrapSearchStrategies.flatMap((strategy) => strategy.routes);
const bootstrapPhysicalSearchStrategyCount = bootstrapSearchRoutes.length + 1;

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
    groupFindUnique: record("group.findUnique", null),
    groupUpdate: record("group.update", { id: "group-id" }),
    knowledgeIndexProfileUpsert: record("knowledgeIndexProfile.upsert", { id: "installation" }),
    knowledgeAnswerPolicyUpsert: record("knowledgeAnswerPolicy.upsert", { id: "installation" }),
    memoryEgressAdminPolicyUpsert: record("memoryEgressAdminPolicy.upsert", { id: "installation" }),
    mcpGrantUpsert: record("mcpGrant.upsert", { id: "mcp-grant-id" }),
    mcpServerFindMany: record("mcpServer.findMany", []),
    modelPolicyUpsert: record("modelPolicy.upsert", { id: "installation" }),
    providerConnectionUpsert: record("providerConnection.upsert", { id: "connection-id" }),
    providerModelCreate: record("providerModel.create", { id: "reranker-model-id" }),
    providerModelFindUnique: record("providerModel.findUnique", null),
    providerModelUpdate: record("providerModel.update", { id: "reranker-model-id" }),
    providerModelUpsert: record("providerModel.upsert", { id: "model-id" }),
    searchIntegrationRevisionCreate: record("searchIntegrationRevision.create", { id: "search-revision-id" }),
    searchOptionUpsert: record("searchOption.upsert", { id: "search-option-id" }),
    searchStrategyUpdate: record("searchStrategy.update", { id: "strategy-id" }),
    searchStrategyUpsert: record("searchStrategy.upsert", { activeRevisionId: null, id: "strategy-id" }),
    systemModelPolicyUpsert: record("systemModelPolicy.upsert", { id: "installation" }),
    workspacePolicyUpsert: record("workspacePolicy.upsert", { id: "installation" }),
    userMemorySettingsUpsert: record("userMemorySettings.upsert", {}),
    userCreate: record("user.create", { id: USER_ID }),
    userFindUnique: record("user.findUnique", user),
    userGroupUpsert: record("userGroup.upsert", {}),
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
      create: spies.groupCreate,
      findUnique: spies.groupFindUnique,
      update: spies.groupUpdate
    },
    knowledgeIndexProfile: {
      upsert: spies.knowledgeIndexProfileUpsert
    },
    knowledgeAnswerPolicy: {
      upsert: spies.knowledgeAnswerPolicyUpsert
    },
    memoryEgressAdminPolicy: {
      upsert: spies.memoryEgressAdminPolicyUpsert
    },
    mcpGrant: {
      upsert: spies.mcpGrantUpsert
    },
    mcpServer: {
      findMany: spies.mcpServerFindMany
    },
    modelPolicy: {
      upsert: spies.modelPolicyUpsert
    },
    providerConnection: {
      upsert: spies.providerConnectionUpsert
    },
    providerModel: {
      create: spies.providerModelCreate,
      findUnique: spies.providerModelFindUnique,
      update: spies.providerModelUpdate,
      upsert: spies.providerModelUpsert
    },
    searchIntegrationRevision: {
      create: spies.searchIntegrationRevisionCreate
    },
    searchOption: {
      upsert: spies.searchOptionUpsert
    },
    searchStrategy: {
      update: spies.searchStrategyUpdate,
      upsert: spies.searchStrategyUpsert
    },
    systemModelPolicy: {
      upsert: spies.systemModelPolicyUpsert
    },
    workspacePolicy: {
      upsert: spies.workspacePolicyUpsert
    },
    user: {
      create: spies.userCreate,
      findUnique: spies.userFindUnique
    },
    userGroup: {
      upsert: spies.userGroupUpsert
    },
    userMemorySettings: {
      upsert: spies.userMemorySettingsUpsert
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
    fixture.spies.groupUpdate,
    fixture.spies.userGroupUpsert,
    fixture.spies.mcpGrantUpsert,
    fixture.spies.folderCreate,
    fixture.spies.userSettingsCreate,
    fixture.spies.userMemorySettingsUpsert,
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
      catalogModelCount: 1 + automaticRerankerRoutePresets.length,
      catalogSearchOptionCount: bootstrapSearchStrategies.length,
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
    expect(fixture.spies.groupCreate).toHaveBeenCalledWith({
      data: {
        name: "Full access",
        systemRole: "full_access"
      },
      select: { id: true }
    });
    expect(fixture.spies.userGroupUpsert).toHaveBeenCalledWith({
      create: {
        groupId: "group-id",
        role: "owner",
        userId: USER_ID
      },
      update: { role: "owner" },
      where: {
        userId_groupId: {
          groupId: "group-id",
          userId: USER_ID
        }
      }
    });
    expect(fixture.spies.folderCreate).not.toHaveBeenCalled();
    expect(fixture.spies.userSettingsCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        defaultFolderId: null,
        defaultProviderModelId: null,
        defaultSearchPlan: { mode: "all_selected", optionIds: [] },
        userId: USER_ID
      })
    });
    const settingsCreateArgs = fixture.spies.userSettingsCreate.mock.calls[0]?.[0] as
      | { data?: Record<string, unknown> }
      | undefined;
    expect(settingsCreateArgs?.data).toBeDefined();
    expect(settingsCreateArgs?.data).not.toHaveProperty("defaultPromptPresetId");
    expect(fixture.spies.providerConnectionUpsert).toHaveBeenCalledTimes(
      providerConnectionTemplates.length
    );
    expect(fixture.spies.providerModelUpsert).toHaveBeenCalledOnce();
    expect(fixture.spies.providerModelCreate).toHaveBeenCalledTimes(
      automaticRerankerRoutePresets.length
    );
    expect(fixture.spies.modelPolicyUpsert).toHaveBeenCalledWith({
      create: { defaultProviderModelId: null, id: "installation" },
      update: {},
      where: { id: "installation" }
    });
    expect(fixture.spies.knowledgeIndexProfileUpsert).toHaveBeenCalledWith({
      create: { id: "installation" },
      update: {},
      where: { id: "installation" }
    });
    expect(fixture.spies.knowledgeAnswerPolicyUpsert).toHaveBeenCalledWith({
      create: { id: "installation" },
      update: {},
      where: { id: "installation" }
    });
    expect(fixture.spies.memoryEgressAdminPolicyUpsert).toHaveBeenCalledWith({
      create: { id: "installation" },
      update: {},
      where: { id: "installation" }
    });
    expect(fixture.spies.systemModelPolicyUpsert).toHaveBeenCalledWith({
      create: {
        id: "installation",
        providerModelId: null,
        reasoningEffort: null,
        rerankerProviderModelId: null
      },
      update: {},
      where: { id: "installation" }
    });
    expect(fixture.spies.workspacePolicyUpsert).toHaveBeenCalledWith({
      create: {
        enabled: false,
        id: "installation",
        internetEnabled: true
      },
      update: {},
      where: { id: "installation" }
    });
    expect(fixture.spies.searchOptionUpsert).toHaveBeenCalledTimes(
      defaultSearchStrategies.length
    );
    expect(fixture.spies.providerModelUpsert.mock.calls[0]?.[0]).toMatchObject({
      create: {
        draftConfig: {
          capabilities: { contextWindow: 8192 }
        },
        enabled: false
      },
      update: {
        activeConfig: Prisma.DbNull,
        activeVersion: 0,
        activatedAt: null,
        enabled: false
      }
    });
    expect(fixture.spies.searchStrategyUpsert).toHaveBeenCalledTimes(
      bootstrapPhysicalSearchStrategyCount
    );
    expect(fixture.spies.searchStrategyUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        adapterKind: "none",
        searchOptionId: "00000000-0000-4000-8000-000000001401",
        strategyId: "search-disabled"
      })
    }));
    for (const [args] of fixture.spies.searchStrategyUpsert.mock.calls) {
      expect((args as { create: { id: string } }).create.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    }
    for (const [args] of fixture.spies.searchIntegrationRevisionCreate.mock.calls) {
      expect((args as { data: { id: string } }).data.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    }

    const productionFoundationCalls = JSON.stringify({
      identities: fixture.spies.authIdentityCreate.mock.calls,
      users: fixture.spies.userCreate.mock.calls
    });
    for (const ordinaryFixture of LOCAL_ORDINARY_USERS) {
      expect(productionFoundationCalls).not.toContain(ordinaryFixture.id);
      expect(productionFoundationCalls).not.toContain(ordinaryFixture.email);
      expect(productionFoundationCalls).not.toContain(ordinaryFixture.password);
    }

    expect(fixture.spies.accessGrantCreateMany).not.toHaveBeenCalled();
    expect(fixture.spies.userMemorySettingsUpsert).not.toHaveBeenCalled();
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

  it("refreshes code-owned metadata without backfilling answer models for an adopted installation", async () => {
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
    expect(fixture.spies.providerConnectionUpsert).toHaveBeenCalledTimes(
      providerConnectionTemplates.length
    );
    expect(fixture.spies.providerModelUpsert).toHaveBeenCalledOnce();
    expect(fixture.spies.providerModelUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { templateKey: "fake:fake-qsa" } })
    );
    expect(fixture.spies.searchOptionUpsert).toHaveBeenCalledTimes(
      defaultSearchStrategies.length
    );
    expect(fixture.spies.searchStrategyUpsert).toHaveBeenCalledTimes(
      bootstrapPhysicalSearchStrategyCount
    );
    const connectionCalls = fixture.spies.providerConnectionUpsert.mock.calls.map(([args]) => args);
    expect(connectionCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        create: expect.objectContaining({ family: "fake", enabled: false }),
        update: {
          activeConfig: Prisma.DbNull,
          activeVersion: 0,
          activatedAt: null,
          enabled: false
        }
      })
    ]));
    for (const args of connectionCalls.filter((entry) => (
      (entry as { create: { family: string } }).create.family !== "fake"
    ))) {
      expect(args).toEqual(expect.objectContaining({ update: {} }));
    }
    for (const [args] of fixture.spies.providerModelUpsert.mock.calls) {
      expect(args).toEqual(expect.objectContaining({
        update: expect.objectContaining({ enabled: false })
      }));
    }
    for (const [args] of fixture.spies.searchStrategyUpsert.mock.calls) {
      expect(args).toEqual(expect.objectContaining({ update: expect.any(Object) }));
      expect((args as { update: object }).update).not.toHaveProperty("enabled");
    }
    expect(fixture.spies.groupCreate).toHaveBeenCalledOnce();
    expect(fixture.spies.userGroupUpsert).toHaveBeenCalledOnce();
    expect(fixture.spies.userMemorySettingsUpsert).toHaveBeenCalledWith({
      create: { userId: USER_ID },
      update: {},
      where: { userId: USER_ID }
    });
    for (const mutation of [
      fixture.spies.userCreate,
      fixture.spies.authIdentityCreate,
      fixture.spies.folderCreate,
      fixture.spies.userSettingsCreate,
      fixture.spies.accessGrantCreateMany
    ]) {
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
