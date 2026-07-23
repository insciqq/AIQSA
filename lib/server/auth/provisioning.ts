import { Prisma } from "@prisma/client";

export type ProvisioningGroupInput = {
  groupId: string;
  role: string;
};

type ProvisionActiveUserInput = {
  groups?: ProvisioningGroupInput[];
  userId: string;
};

const DEFAULT_PROMPT_NAME = "Helpful Assistant";
const DEFAULT_SYSTEM_PROMPT = "You are a helpful AI assistant. Today is {local_date}, local time is {local_time}.";

const json = (value: unknown) => value as Prisma.InputJsonValue;

export async function provisionActiveUser(
  tx: Prisma.TransactionClient,
  input: ProvisionActiveUserInput
): Promise<void> {
  for (const group of input.groups ?? []) {
    await tx.userGroup.upsert({
      create: {
        groupId: group.groupId,
        role: group.role,
        userId: input.userId
      },
      update: {
        role: group.role
      },
      where: {
        userId_groupId: {
          groupId: group.groupId,
          userId: input.userId
        }
      }
    });
  }

  let prompt = await tx.promptPreset.findFirst({
    where: {
      isDefault: true,
      userId: input.userId
    }
  });

  if (!prompt) {
    prompt = await tx.promptPreset.findFirst({
      where: {
        name: DEFAULT_PROMPT_NAME,
        userId: input.userId
      }
    });

    if (prompt) {
      await tx.promptPreset.updateMany({
        data: {
          isDefault: false
        },
        where: {
          isDefault: true,
          userId: input.userId
        }
      });
      prompt = await tx.promptPreset.update({
        data: {
          isDefault: true
        },
        where: {
          id: prompt.id
        }
      });
    } else {
      prompt = await tx.promptPreset.create({
        data: {
          developerPrompt: null,
          isDefault: true,
          name: DEFAULT_PROMPT_NAME,
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
          userId: input.userId
        }
      });
    }
  }

  await tx.userSettings.upsert({
    create: {
      defaultControlValues: json({}),
      defaultFolderId: null,
      defaultModelId: "gpt-5.5",
      defaultPromptPresetId: prompt.id,
      defaultProvider: "openai",
      defaultSearchStrategyId: "openai-native-web-search",
      showCitations: true,
      showReasoningBlocks: false,
      showToolActivity: true,
      userId: input.userId
    },
    update: {},
    where: {
      userId: input.userId
    }
  });
}
