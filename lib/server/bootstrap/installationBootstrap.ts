import { randomUUID as randomNodeUuid } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { defaultProviderModels, defaultSearchStrategies } from "@/lib/domain/catalog";
import {
  providerConnectionTemplates,
  providerTemplateIds
} from "@/lib/domain/providerTemplates";
import {
  hashPassword as hashAuthPassword,
  isPlausibleEmail,
  normalizeAuthEmail,
  validatePassword
} from "@/lib/server/auth/password";
import { ensureFullAccessGroup } from "@/lib/server/auth/fullAccessGroup";
import {
  builtInSearchDraft,
  normalizeSearchDraft,
  searchDraftHash
} from "@/lib/server/search/configuration";
import { searchValidationFingerprint } from "@/lib/server/search/probeBinding";

const BOOTSTRAP_LOCK_KEY = "aiqsa:installation-bootstrap:v1";
const MAX_DISPLAY_NAME_LENGTH = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BUILT_IN_SEARCH_OPTIONS = Object.freeze({
  "anthropic-web-search": Object.freeze({
    description: "Web search provided by Anthropic.",
    displayName: "Anthropic Search",
    id: "00000000-0000-4000-8000-000000001405",
    kind: "web_search",
    sourceConnectionId: providerTemplateIds.anthropicConnection,
    templateKey: "search:anthropic"
  }),
  "gemini-google-search": Object.freeze({
    description: "Google Search grounding for eligible Gemini models.",
    displayName: "Google Search",
    id: "00000000-0000-4000-8000-000000001403",
    kind: "gemini_google_search",
    sourceConnectionId: providerTemplateIds.geminiConnection,
    templateKey: "search:gemini-google"
  }),
  "openai-native-web-search": Object.freeze({
    description: "Web search provided by OpenAI.",
    displayName: "OpenAI Search",
    id: "00000000-0000-4000-8000-000000001402",
    kind: "web_search",
    sourceConnectionId: providerTemplateIds.openAiConnection,
    templateKey: "search:openai"
  }),
  "perplexity-tool-search": Object.freeze({
    description: "Web search provided by Perplexity through OpenRouter.",
    displayName: "Perplexity Search",
    id: "00000000-0000-4000-8000-000000001404",
    kind: "perplexity_search",
    sourceConnectionId: providerTemplateIds.openRouterConnection,
    templateKey: "search:perplexity"
  }),
  "search-disabled": Object.freeze({
    description: "Answer without web search.",
    displayName: "Off",
    id: "00000000-0000-4000-8000-000000001401",
    kind: "none",
    sourceConnectionId: null,
    templateKey: "search:none"
  })
});

function builtInSearchOption(strategyId: string) {
  return BUILT_IN_SEARCH_OPTIONS[strategyId as keyof typeof BUILT_IN_SEARCH_OPTIONS];
}

export type InstallationBootstrapInput = {
  displayName: string;
  email: string;
  password?: string;
  userId?: string;
};

export type InstallationBootstrapResult = {
  catalogModelCount: number;
  catalogSearchStrategyCount: number;
  status: "already_adopted" | "created";
};

export type InstallationBootstrapErrorCode =
  | "display_name_invalid"
  | "email_invalid"
  | "fresh_database_password_required"
  | "password_too_long"
  | "password_too_short"
  | "preflight_failed"
  | "required_environment_missing"
  | "unsafe_nonempty_database"
  | "user_id_invalid";

export class InstallationBootstrapError extends Error {
  readonly code: InstallationBootstrapErrorCode;

  constructor(code: InstallationBootstrapErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "InstallationBootstrapError";
  }
}

type InstallationBootstrapDependencies = {
  hashPassword?: (password: string) => Promise<string>;
  now?: () => Date;
  randomUUID?: () => string;
};

type ValidatedInstallationBootstrapInput = {
  displayName: string;
  email: string;
  password?: string;
  userId?: string;
};

type ResolvedInstallationBootstrapInput = Omit<ValidatedInstallationBootstrapInput, "userId"> & {
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
    throw new InstallationBootstrapError(
      "required_environment_missing",
      `${name} is required for installation bootstrap.`
    );
  }

  return value;
}

export function installationBootstrapInputFromEnv(
  env: Record<string, string | undefined> = process.env
): InstallationBootstrapInput {
  const password = env.AIQSA_INITIAL_ADMIN_PASSWORD;
  const userId = env.AIQSA_INITIAL_ADMIN_USER_ID?.trim();

  return {
    displayName: env.AIQSA_INITIAL_ADMIN_DISPLAY_NAME?.trim() || "Administrator",
    email: requiredEnvironmentValue(env, "AIQSA_INITIAL_ADMIN_EMAIL"),
    ...(password ? { password } : {}),
    ...(userId ? { userId } : {})
  };
}

export function validateInstallationBootstrapInput(
  input: InstallationBootstrapInput
): ValidatedInstallationBootstrapInput {
  const email = normalizeAuthEmail(input.email);
  const displayName = input.displayName.trim();
  const userId = input.userId?.trim();

  if (!isPlausibleEmail(email)) {
    throw new InstallationBootstrapError(
      "email_invalid",
      "AIQSA_INITIAL_ADMIN_EMAIL must be a valid email address."
    );
  }

  if (!displayName || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new InstallationBootstrapError(
      "display_name_invalid",
      `AIQSA_INITIAL_ADMIN_DISPLAY_NAME must contain 1-${MAX_DISPLAY_NAME_LENGTH} characters.`
    );
  }

  if (userId && !UUID_PATTERN.test(userId)) {
    throw new InstallationBootstrapError(
      "user_id_invalid",
      "AIQSA_INITIAL_ADMIN_USER_ID must be a canonical UUID."
    );
  }

  if (input.password !== undefined) {
    const passwordError = validatePassword(input.password);

    if (passwordError) {
      const passwordErrorCode =
        passwordError === "password_too_long" ? "password_too_long" : "password_too_short";

      throw new InstallationBootstrapError(
        passwordErrorCode,
        `AIQSA_INITIAL_ADMIN_PASSWORD failed validation (${passwordError}).`
      );
    }
  }

  return {
    displayName,
    email,
    ...(input.password !== undefined ? { password: input.password } : {}),
    ...(userId ? { userId } : {})
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
        UNION ALL SELECT 1 FROM "AssistantDefinition"
        UNION ALL SELECT 1 FROM "ProviderModel"
        UNION ALL SELECT 1 FROM "ProviderCredential"
        UNION ALL SELECT 1 FROM "ProviderCredentialVersion"
        UNION ALL SELECT 1 FROM "ProviderGroupCredentialAssignment"
        UNION ALL SELECT 1 FROM "ProviderUserCredentialAssignment"
        UNION ALL SELECT 1 FROM "ProviderRunBinding"
        -- This code-owned strategy is inserted by its append-only migration
        -- even on a fresh schema, before installation bootstrap runs.
        UNION ALL SELECT 1 FROM "SearchStrategy"
          WHERE "strategyId" NOT IN ('anthropic-web-search', 'gemini-google-search')
        UNION ALL SELECT 1 FROM "Chat"
        UNION ALL SELECT 1 FROM "Message"
        UNION ALL SELECT 1 FROM "ModelRun"
        UNION ALL SELECT 1 FROM "ModelRunEvent"
        UNION ALL SELECT 1 FROM "McpServer"
        UNION ALL SELECT 1 FROM "McpRevision"
        UNION ALL SELECT 1 FROM "McpGrant"
        UNION ALL SELECT 1 FROM "McpUserServer"
        UNION ALL SELECT 1 FROM "McpOAuthClient"
        UNION ALL SELECT 1 FROM "McpOAuthConnection"
        UNION ALL SELECT 1 FROM "McpRuntimeGeneration"
        UNION ALL SELECT 1 FROM "McpRunBinding"
        UNION ALL SELECT 1 FROM "ModelRunToolCall"
        UNION ALL SELECT 1 FROM "SearchRun"
        UNION ALL SELECT 1 FROM "Attachment"
        UNION ALL SELECT 1 FROM "AttachmentDeletionJob"
        UNION ALL SELECT 1 FROM "SharedChatSnapshot"
        UNION ALL SELECT 1 FROM "UsageEvent"
      ) application_rows
      LIMIT 1
    )::text AS "nonempty"
  `;
  const nonempty = rows[0]?.nonempty;

  if (nonempty !== "true" && nonempty !== "false") {
    throw new InstallationBootstrapError(
      "preflight_failed",
      "Installation bootstrap could not determine whether the application database is empty."
    );
  }

  return nonempty === "true";
}

function isExactAdoptedIdentity(input: {
  identity: AdoptedPasswordIdentity | null;
  normalizedEmail: string;
  requestedUserId?: string;
  user: AdoptedUser | null;
}): boolean {
  return Boolean(
    input.identity &&
      input.user?.id === input.identity.userId &&
      input.user.email &&
      normalizeAuthEmail(input.user.email) === input.normalizedEmail &&
      input.identity.normalizedEmail === input.normalizedEmail &&
      input.identity.providerAccountId === input.normalizedEmail &&
      input.identity.emailVerifiedAt &&
      input.identity.passwordHash &&
      (!input.requestedUserId || input.identity.userId === input.requestedUserId)
  );
}

async function inspectBootstrapState(
  tx: Prisma.TransactionClient,
  input: ValidatedInstallationBootstrapInput
): Promise<{ adoptedUserId: string | null; nonempty: boolean }> {
  const [nonempty, identity] = await Promise.all([
    hasApplicationRows(tx),
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
        providerAccountId: input.email
      }
    })
  ]);
  const user = identity
    ? await tx.user.findUnique({
        select: {
          email: true,
          id: true
        },
        where: {
          id: identity.userId
        }
      })
    : null;
  const adopted = isExactAdoptedIdentity({
    identity,
    normalizedEmail: input.email,
    requestedUserId: input.userId,
    user
  });

  return {
    adoptedUserId: adopted && identity ? identity.userId : null,
    nonempty
  };
}

async function synchronizeCodeOwnedCatalog(tx: Prisma.TransactionClient): Promise<void> {
  for (const template of providerConnectionTemplates) {
    const isFake = template.family === "fake";
    await tx.providerConnection.upsert({
      create: {
        displayName: template.displayName,
        draftConfig: json(template.config),
        enabled: template.enabled,
        family: template.family,
        id: template.id,
        templateKey: template.templateKey
      },
      update: isFake
        ? {
            activeConfig: Prisma.DbNull,
            activeVersion: 0,
            activatedAt: null,
            enabled: false
          }
        : {},
      where: { id: template.id }
    });
  }

  const fake = defaultProviderModels.find((model) => model.provider === "fake");
  if (!fake) {
    throw new InstallationBootstrapError("preflight_failed", "Fake provider template is missing.");
  }
  const fakeConfig = {
    adapterKind: "fake",
    capabilities: {
      ...fake.capabilities,
      contextWindow: fake.contextWindow
    },
    defaultParams: fake.defaultParams,
    upstreamModelId: fake.modelId
  };
  await tx.providerModel.upsert({
    create: {
      capabilities: json(fake.capabilities),
      connectionId: providerTemplateIds.fakeConnection,
      contextWindow: fake.contextWindow,
      defaultParams: json(fake.defaultParams),
      displayName: fake.displayName,
      draftConfig: json(fakeConfig),
      enabled: false,
      id: providerTemplateIds.fakeModel,
      inputTokenPriceMicros: fake.inputTokenPriceMicros,
      modelId: fake.modelId,
      outputTokenPriceMicros: fake.outputTokenPriceMicros,
      provider: fake.provider,
      supportsNativeSearch: fake.capabilities.nativeSearch,
      supportsPdf: fake.capabilities.pdf,
      supportsReasoning: fake.capabilities.reasoning,
      supportsVision: fake.capabilities.vision,
      templateKey: "fake:fake-qsa"
    },
    update: {
      activeConfig: Prisma.DbNull,
      activeVersion: 0,
      activatedAt: null,
      enabled: false
    },
    where: { templateKey: "fake:fake-qsa" }
  });

  for (const [optionId, option] of Object.entries(BUILT_IN_SEARCH_OPTIONS)) {
    await tx.searchOption.upsert({
      create: {
        description: option.description,
        displayName: option.displayName,
        enabled: true,
        id: option.id,
        kind: option.kind,
        optionId,
        sourceConnectionId: option.sourceConnectionId,
        templateKey: option.templateKey
      },
      update: {
        description: option.description,
        displayName: option.displayName,
        kind: option.kind,
        sourceConnectionId: option.sourceConnectionId,
        templateKey: option.templateKey
      },
      where: { id: option.id }
    });
  }

  for (const logicalOption of defaultSearchStrategies.filter(
    (candidate) => candidate.kind !== "perplexity_tool_search"
  )) {
    const searchOption = builtInSearchOption(logicalOption.strategyId);
    if (!searchOption) {
      throw new InstallationBootstrapError(
        "preflight_failed",
        `Built-in Search option is missing for ${logicalOption.strategyId}.`
      );
    }
    const physicalRoutes = logicalOption.kind === "none"
      ? [{ config: {}, kind: "none", physicalStrategyId: logicalOption.strategyId }]
      : logicalOption.routes;
    for (const route of physicalRoutes) {
      const draft = builtInSearchDraft({ config: route.config, kind: route.kind });
      const draftHash = route.kind === "none"
        ? `bootstrap:${route.physicalStrategyId}`
        : searchDraftHash(normalizeSearchDraft(draft));
      const stored = await tx.searchStrategy.upsert({
        create: {
          adapterKind: String(draft.adapterKind),
          config: json(route.config),
          credentialMode: String(draft.credentialMode),
          description: logicalOption.description,
          displayName: logicalOption.displayName,
          draft: json(draft),
          draftTestEvidence: json({
            checkedAt: new Date().toISOString(),
            method: "configuration",
            normalizedSourceCount: 0,
            protocol: draft.protocol,
            status: "available"
          }),
          enabled: true,
          // SearchStrategy participates in the composite active-revision
          // relation. Supply the fresh-row identity explicitly so PostgreSQL
          // never sees a null id through Prisma's upsert path.
          id: randomNodeUuid(),
          kind: route.kind,
          modelId: null,
          provider: logicalOption.sourceConnectionId ?? "fake",
          searchOptionId: searchOption.id,
          strategyId: route.physicalStrategyId,
          testedDraftHash: draftHash
        },
        update: {
          config: json(route.config),
          description: logicalOption.description,
          displayName: logicalOption.displayName,
          kind: route.kind,
          modelId: null,
          provider: logicalOption.sourceConnectionId ?? "fake",
          searchOptionId: searchOption.id
        },
        where: {
          strategyId: route.physicalStrategyId
        }
      });
      if (!stored.activeRevisionId) {
        const revision = await tx.searchIntegrationRevision.create({
          data: {
            adapterKind: String(draft.adapterKind),
            configuration: json(draft),
            credentialMode: String(draft.credentialMode),
            draftHash,
            id: randomNodeUuid(),
            providerModelId: null,
            revisionNumber: 1,
            searchStrategyId: stored.id,
            validationEvidence: json({ method: "bootstrap", status: "available" }),
            validationFingerprint: searchValidationFingerprint({
              method: "bootstrap",
              status: "available"
            })
          }
        });
        await tx.searchStrategy.update({
          data: { activeRevisionId: revision.id, activatedAt: new Date() },
          where: { id: stored.id }
        });
      }
    }
  }

  await tx.modelPolicy.upsert({
    create: {
      defaultProviderModelId: null,
      id: "installation"
    },
    // Bootstrap adoption repairs missing code-owned foundation only. It never
    // replaces an operator's installation-default choice.
    update: {},
    where: { id: "installation" }
  });
}

async function createInitialAdminFoundation(
  tx: Prisma.TransactionClient,
  input: ResolvedInstallationBootstrapInput,
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

  await ensureFullAccessGroup(tx, input.userId);

  await tx.userSettings.create({
    data: {
      defaultControlValues: json({}),
      defaultFolderId: null,
      defaultProviderModelId: null,
      defaultSearchStrategyId: "search-disabled",
      showCitations: true,
      showReasoningBlocks: false,
      showToolActivity: true,
      userId: input.userId
    }
  });

}

export async function bootstrapInstallationDatabase(
  prisma: PrismaClient,
  rawInput: InstallationBootstrapInput,
  dependencies: InstallationBootstrapDependencies = {}
): Promise<InstallationBootstrapResult> {
  const input = validateInstallationBootstrapInput(rawInput);
  const hashPassword = dependencies.hashPassword ?? hashAuthPassword;
  const now = dependencies.now ?? (() => new Date());
  const randomUUID = dependencies.randomUUID ?? randomNodeUuid;

  return prisma.$transaction(
    async (tx) => {
      await lockBootstrapTransaction(tx);
      const state = await inspectBootstrapState(tx, input);

      if (state.nonempty && !state.adoptedUserId) {
        throw new InstallationBootstrapError(
          "unsafe_nonempty_database",
          "Refusing installation bootstrap: the database is nonempty and does not contain the adopted initial-admin password identity."
        );
      }

      if (!state.nonempty && state.adoptedUserId) {
        throw new InstallationBootstrapError(
          "preflight_failed",
          "Installation bootstrap found an inconsistent empty-database preflight result."
        );
      }

      if (state.adoptedUserId) {
        await synchronizeCodeOwnedCatalog(tx);
        await ensureFullAccessGroup(tx, state.adoptedUserId);

        return {
          catalogModelCount: 1,
          catalogSearchStrategyCount: defaultSearchStrategies.filter(
            (strategy) => strategy.kind !== "perplexity_tool_search"
          ).length,
          status: "already_adopted"
        };
      }

      if (!input.password) {
        throw new InstallationBootstrapError(
          "fresh_database_password_required",
          "AIQSA_INITIAL_ADMIN_PASSWORD is required for a fresh database."
        );
      }

      const userId = input.userId ?? randomUUID();
      if (!UUID_PATTERN.test(userId)) {
        throw new InstallationBootstrapError(
          "preflight_failed",
          "Installation bootstrap could not generate a valid initial-admin UUID."
        );
      }

      const passwordHash = await hashPassword(input.password);
      await synchronizeCodeOwnedCatalog(tx);
      await createInitialAdminFoundation(tx, { ...input, userId }, passwordHash, now());

      return {
        catalogModelCount: 1,
        catalogSearchStrategyCount: defaultSearchStrategies.filter(
          (strategy) => strategy.kind !== "perplexity_tool_search"
        ).length,
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
