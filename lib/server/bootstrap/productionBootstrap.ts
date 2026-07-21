import { Prisma, type PrismaClient } from "@prisma/client";
import { defaultProviderModels, defaultSearchStrategies } from "@/lib/domain/catalog";
import {
  hashPassword as hashAuthPassword,
  isPlausibleEmail,
  normalizeAuthEmail,
  validatePassword
} from "@/lib/server/auth/password";

const BOOTSTRAP_LOCK_KEY = "aiqsa:production-bootstrap:v1";
const INITIAL_ADMIN_GROUP_NAME = "private-operators";
const INITIAL_PROMPT_NAME = "Helpful Assistant";
const INITIAL_SYSTEM_PROMPT =
  "You are a helpful AI assistant. Today is {local_date}, local time is {local_time}.";
const MAX_DISPLAY_NAME_LENGTH = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ProductionBootstrapInput = {
  displayName: string;
  email: string;
  password?: string;
  userId: string;
};

export type ProductionBootstrapResult = {
  catalogModelCount: number;
  catalogSearchStrategyCount: number;
  status: "already_adopted" | "created";
};

export type ProductionBootstrapErrorCode =
  | "display_name_invalid"
  | "email_invalid"
  | "fresh_database_password_required"
  | "password_too_long"
  | "password_too_short"
  | "preflight_failed"
  | "required_environment_missing"
  | "unsafe_nonempty_database"
  | "user_id_invalid";

export class ProductionBootstrapError extends Error {
  readonly code: ProductionBootstrapErrorCode;

  constructor(code: ProductionBootstrapErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ProductionBootstrapError";
  }
}

type ProductionBootstrapDependencies = {
  hashPassword?: (password: string) => Promise<string>;
  now?: () => Date;
};

type ValidatedProductionBootstrapInput = {
  displayName: string;
  email: string;
  password?: string;
  userId: string;
};

type AdoptedUser = {
  email: string | null;
  id: string;
};

type AdoptedPasswordIdentity = {
  emailVerifiedAt: Date | null;
  normalizedEmail: string;
  passwordHash: string | null;
  providerAccountId: string;
  userId: string;
};

const json = (value: unknown) => value as Prisma.InputJsonValue;

function requiredEnvironmentValue(
  env: Record<string, string | undefined>,
  name: string
): string {
  const value = env[name]?.trim();

  if (!value) {
    throw new ProductionBootstrapError(
      "required_environment_missing",
      `${name} is required for the production bootstrap.`
    );
  }

  return value;
}

export function productionBootstrapInputFromEnv(
  env: Record<string, string | undefined> = process.env
): ProductionBootstrapInput {
  const password = env.AIQSA_INITIAL_ADMIN_PASSWORD;

  return {
    displayName: requiredEnvironmentValue(env, "AIQSA_INITIAL_ADMIN_DISPLAY_NAME"),
    email: requiredEnvironmentValue(env, "AIQSA_INITIAL_ADMIN_EMAIL"),
    ...(password ? { password } : {}),
    userId: requiredEnvironmentValue(env, "AIQSA_INITIAL_ADMIN_USER_ID")
  };
}

export function validateProductionBootstrapInput(
  input: ProductionBootstrapInput
): ValidatedProductionBootstrapInput {
  const email = normalizeAuthEmail(input.email);
  const displayName = input.displayName.trim();
  const userId = input.userId.trim();

  if (!isPlausibleEmail(email)) {
    throw new ProductionBootstrapError(
      "email_invalid",
      "AIQSA_INITIAL_ADMIN_EMAIL must be a valid email address."
    );
  }

  if (!displayName || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ProductionBootstrapError(
      "display_name_invalid",
      `AIQSA_INITIAL_ADMIN_DISPLAY_NAME must contain 1-${MAX_DISPLAY_NAME_LENGTH} characters.`
    );
  }

  if (!UUID_PATTERN.test(userId)) {
    throw new ProductionBootstrapError(
      "user_id_invalid",
      "AIQSA_INITIAL_ADMIN_USER_ID must be a canonical UUID."
    );
  }

  if (input.password !== undefined) {
    const passwordError = validatePassword(input.password);

    if (passwordError) {
      const passwordErrorCode =
        passwordError === "password_too_long" ? "password_too_long" : "password_too_short";

      throw new ProductionBootstrapError(
        passwordErrorCode,
        `AIQSA_INITIAL_ADMIN_PASSWORD failed validation (${passwordError}).`
      );
    }
  }

  return {
    displayName,
    email,
    ...(input.password !== undefined ? { password: input.password } : {}),
    userId
  };
}

async function lockBootstrapTransaction(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw<Array<{ lock: string }>>`
    SELECT pg_advisory_xact_lock(hashtextextended(${BOOTSTRAP_LOCK_KEY}, 0))::text AS "lock"
  `;
}

async function hasApplicationRows(tx: Prisma.TransactionClient): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ nonempty: string }>>`
    SELECT EXISTS (
      SELECT 1
      FROM (
        SELECT 1 FROM "User"
        UNION ALL SELECT 1 FROM "AuthIdentity"
        UNION ALL SELECT 1 FROM "AuthSession"
        UNION ALL SELECT 1 FROM "AuthAccessRule"
        UNION ALL SELECT 1 FROM "AuthAccessRuleGroup"
        UNION ALL SELECT 1 FROM "AuthInvite"
        UNION ALL SELECT 1 FROM "AuthInviteGroup"
        UNION ALL SELECT 1 FROM "AuthFlowToken"
        UNION ALL SELECT 1 FROM "Group"
        UNION ALL SELECT 1 FROM "UserGroup"
        UNION ALL SELECT 1 FROM "UserSettings"
        UNION ALL SELECT 1 FROM "AccessGrant"
        UNION ALL SELECT 1 FROM "Folder"
        UNION ALL SELECT 1 FROM "PromptPreset"
        UNION ALL SELECT 1 FROM "ProviderModel"
        UNION ALL SELECT 1 FROM "SearchStrategy"
        UNION ALL SELECT 1 FROM "Chat"
        UNION ALL SELECT 1 FROM "Message"
        UNION ALL SELECT 1 FROM "ModelRun"
        UNION ALL SELECT 1 FROM "ModelRunEvent"
        UNION ALL SELECT 1 FROM "SearchRun"
        UNION ALL SELECT 1 FROM "Attachment"
        UNION ALL SELECT 1 FROM "SharedChatSnapshot"
        UNION ALL SELECT 1 FROM "UsageEvent"
      ) application_rows
      LIMIT 1
    )::text AS "nonempty"
  `;
  const nonempty = rows[0]?.nonempty;

  if (nonempty !== "true" && nonempty !== "false") {
    throw new ProductionBootstrapError(
      "preflight_failed",
      "Production bootstrap could not determine whether the application database is empty."
    );
  }

  return nonempty === "true";
}

function isExactAdoptedIdentity(input: {
  identity: AdoptedPasswordIdentity | null;
  normalizedEmail: string;
  user: AdoptedUser | null;
  userId: string;
}): boolean {
  return Boolean(
    input.user?.id === input.userId &&
      input.user.email &&
      normalizeAuthEmail(input.user.email) === input.normalizedEmail &&
      input.identity?.userId === input.userId &&
      input.identity.normalizedEmail === input.normalizedEmail &&
      input.identity.providerAccountId === input.normalizedEmail &&
      input.identity.emailVerifiedAt &&
      input.identity.passwordHash
  );
}

async function inspectBootstrapState(
  tx: Prisma.TransactionClient,
  input: ValidatedProductionBootstrapInput
): Promise<{ adopted: boolean; nonempty: boolean }> {
  const [nonempty, user, identity] = await Promise.all([
    hasApplicationRows(tx),
    tx.user.findUnique({
      select: {
        email: true,
        id: true
      },
      where: {
        id: input.userId
      }
    }),
    tx.authIdentity.findFirst({
      select: {
        emailVerifiedAt: true,
        normalizedEmail: true,
        passwordHash: true,
        providerAccountId: true,
        userId: true
      },
      where: {
        normalizedEmail: input.email,
        provider: "password",
        providerAccountId: input.email,
        userId: input.userId
      }
    })
  ]);

  return {
    adopted: isExactAdoptedIdentity({
      identity,
      normalizedEmail: input.email,
      user,
      userId: input.userId
    }),
    nonempty
  };
}

async function synchronizeCodeOwnedCatalog(tx: Prisma.TransactionClient): Promise<void> {
  for (const model of defaultProviderModels) {
    await tx.providerModel.upsert({
      create: {
        capabilities: json(model.capabilities),
        contextWindow: model.contextWindow,
        defaultParams: json(model.defaultParams),
        displayName: model.displayName,
        enabled: true,
        inputTokenPriceMicros: model.inputTokenPriceMicros,
        modelId: model.modelId,
        outputTokenPriceMicros: model.outputTokenPriceMicros,
        provider: model.provider,
        supportsNativeSearch: model.capabilities.nativeSearch,
        supportsPdf: model.capabilities.pdf,
        supportsReasoning: model.capabilities.reasoning,
        supportsVision: model.capabilities.vision
      },
      update: {
        capabilities: json(model.capabilities),
        contextWindow: model.contextWindow,
        defaultParams: json(model.defaultParams),
        displayName: model.displayName,
        inputTokenPriceMicros: model.inputTokenPriceMicros,
        outputTokenPriceMicros: model.outputTokenPriceMicros,
        supportsNativeSearch: model.capabilities.nativeSearch,
        supportsPdf: model.capabilities.pdf,
        supportsReasoning: model.capabilities.reasoning,
        supportsVision: model.capabilities.vision
      },
      where: {
        provider_modelId: {
          modelId: model.modelId,
          provider: model.provider
        }
      }
    });
  }

  for (const strategy of defaultSearchStrategies) {
    await tx.searchStrategy.upsert({
      create: {
        config: json(strategy.config),
        description: strategy.description,
        displayName: strategy.displayName,
        enabled: true,
        kind: strategy.kind,
        modelId: strategy.modelId ?? null,
        provider: strategy.provider,
        strategyId: strategy.strategyId
      },
      update: {
        config: json(strategy.config),
        description: strategy.description,
        displayName: strategy.displayName,
        kind: strategy.kind,
        modelId: strategy.modelId ?? null,
        provider: strategy.provider
      },
      where: {
        strategyId: strategy.strategyId
      }
    });
  }
}

async function createInitialAdminFoundation(
  tx: Prisma.TransactionClient,
  input: ValidatedProductionBootstrapInput,
  passwordHash: string,
  now: Date
): Promise<void> {
  await tx.user.create({
    data: {
      displayName: input.displayName,
      email: input.email,
      id: input.userId,
      role: "admin",
      status: "active"
    }
  });

  await tx.authIdentity.create({
    data: {
      emailVerifiedAt: now,
      normalizedEmail: input.email,
      passwordHash,
      provider: "password",
      providerAccountId: input.email,
      userId: input.userId
    }
  });

  const group = await tx.group.create({
    data: {
      name: INITIAL_ADMIN_GROUP_NAME
    }
  });

  await tx.userGroup.create({
    data: {
      groupId: group.id,
      role: "owner",
      userId: input.userId
    }
  });

  const prompt = await tx.promptPreset.create({
    data: {
      developerPrompt: null,
      isDefault: true,
      name: INITIAL_PROMPT_NAME,
      systemPrompt: INITIAL_SYSTEM_PROMPT,
      userId: input.userId
    }
  });

  await tx.userSettings.create({
    data: {
      defaultControlValues: json({}),
      defaultFolderId: null,
      defaultModelId: "gpt-5.5",
      defaultPromptPresetId: prompt.id,
      defaultProvider: "openai",
      defaultSearchStrategyId: "openai-native-web-search",
      showCitations: true,
      showReasoningBlocks: false,
      userId: input.userId
    }
  });

  await tx.accessGrant.createMany({
    data: [
      ...defaultProviderModels
        .filter((model) => model.provider !== "fake")
        .map((model) => ({
          enabled: true,
          groupId: group.id,
          modelId: model.modelId,
          provider: model.provider
        })),
      ...defaultSearchStrategies
        .filter((strategy) => strategy.strategyId !== "search-disabled")
        .map((strategy) => ({
          enabled: true,
          groupId: group.id,
          searchStrategy: strategy.strategyId
        }))
    ]
  });
}

export async function bootstrapProductionDatabase(
  prisma: PrismaClient,
  rawInput: ProductionBootstrapInput,
  dependencies: ProductionBootstrapDependencies = {}
): Promise<ProductionBootstrapResult> {
  const input = validateProductionBootstrapInput(rawInput);
  const hashPassword = dependencies.hashPassword ?? hashAuthPassword;
  const now = dependencies.now ?? (() => new Date());

  return prisma.$transaction(
    async (tx) => {
      await lockBootstrapTransaction(tx);
      const state = await inspectBootstrapState(tx, input);

      if (state.nonempty && !state.adopted) {
        throw new ProductionBootstrapError(
          "unsafe_nonempty_database",
          "Refusing production bootstrap: the database is nonempty and does not contain the exact adopted initial-admin identity."
        );
      }

      if (!state.nonempty && state.adopted) {
        throw new ProductionBootstrapError(
          "preflight_failed",
          "Production bootstrap found an inconsistent empty-database preflight result."
        );
      }

      if (state.adopted) {
        await synchronizeCodeOwnedCatalog(tx);

        return {
          catalogModelCount: defaultProviderModels.length,
          catalogSearchStrategyCount: defaultSearchStrategies.length,
          status: "already_adopted"
        };
      }

      if (!input.password) {
        throw new ProductionBootstrapError(
          "fresh_database_password_required",
          "AIQSA_INITIAL_ADMIN_PASSWORD is required for a fresh production database."
        );
      }

      const passwordHash = await hashPassword(input.password);
      await synchronizeCodeOwnedCatalog(tx);
      await createInitialAdminFoundation(tx, input, passwordHash, now());

      return {
        catalogModelCount: defaultProviderModels.length,
        catalogSearchStrategyCount: defaultSearchStrategies.length,
        status: "created"
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 120_000
    }
  );
}
