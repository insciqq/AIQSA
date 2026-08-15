import { Prisma } from "@prisma/client";

export type ProvisioningGroupInput = {
  groupId: string;
  role: string;
};

type ProvisionActiveUserInput = {
  groups?: ProvisioningGroupInput[];
  userId: string;
};

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

  // No prompt preset is provisioned: ordinary no-Assistant runs receive the
  // code-owned standard-chat baseline at run admission instead of a database
  // object.
  await tx.userSettings.upsert({
    create: {
      defaultControlValues: json({}),
      defaultFolderId: null,
      defaultProviderModelId: null,
      defaultSearchPlan: json({ mode: "all_selected", optionIds: [] }),
      showCitations: true,
      showReasoningBlocks: false,
      userId: input.userId
    },
    update: {},
    where: {
      userId: input.userId
    }
  });
}
