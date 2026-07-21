import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { hashPassword } from "../../lib/server/auth/password";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";

test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();

async function createActivePasswordUser(input: {
  displayName: string;
  email: string;
  groupId: string;
  password: string;
}) {
  const user = await prisma.user.create({
    data: {
      authIdentities: {
        create: {
          emailVerifiedAt: new Date("2026-06-14T00:00:00.000Z"),
          normalizedEmail: input.email,
          passwordHash: await hashPassword(input.password),
          provider: "password",
          providerAccountId: input.email
        }
      },
      displayName: input.displayName,
      email: input.email,
      status: "active"
    }
  });

  await prisma.$transaction((tx) =>
    provisionActiveUser(tx, {
      groups: [
        {
          groupId: input.groupId,
          role: "member"
        }
      ],
      userId: user.id
    })
  );

  return user;
}

async function loginWithPassword(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test("keeps two active password users in isolated workspaces", async ({ browser }) => {
  const id = randomUUID();
  const domain = `rollout-${id}.example.com`;
  const title = `Private rollout chat ${id}`;
  const group = await prisma.group.create({
    data: {
      name: `rollout-${id}`
    }
  });
  const firstPassword = `first-password-${id}`;
  const secondPassword = `second-password-${id}`;
  const firstEmail = `first@${domain}`;
  const secondEmail = `second@${domain}`;
  let firstPage: Page | null = null;
  let secondPage: Page | null = null;

  await prisma.accessGrant.createMany({
    data: [
      {
        groupId: group.id,
        provider: "openai",
        modelId: "gpt-5.5"
      },
      {
        groupId: group.id,
        searchStrategy: "openai-native-web-search"
      }
    ]
  });
  await createActivePasswordUser({
    displayName: "First Rollout User",
    email: firstEmail,
    groupId: group.id,
    password: firstPassword
  });
  await createActivePasswordUser({
    displayName: "Second Rollout User",
    email: secondEmail,
    groupId: group.id,
    password: secondPassword
  });

  try {
    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    firstPage = await firstContext.newPage();
    secondPage = await secondContext.newPage();

    await loginWithPassword(firstPage, firstEmail, firstPassword);
    await loginWithPassword(secondPage, secondEmail, secondPassword);

    const createResponse = await firstPage.request.post("/api/chats", {
      data: {
        title
      }
    });
    expect(createResponse.status()).toBe(201);
    const created = (await createResponse.json()) as { chat: { id: string; title: string } };

    const firstWorkspace = (await (await firstPage.request.get("/api/chats")).json()) as {
      chats: { id: string; title: string }[];
    };
    const secondWorkspace = (await (await secondPage.request.get("/api/chats")).json()) as {
      chats: { id: string; title: string }[];
    };

    expect(firstWorkspace.chats.some((chat) => chat.id === created.chat.id && chat.title === title)).toBe(true);
    expect(secondWorkspace.chats.some((chat) => chat.id === created.chat.id || chat.title === title)).toBe(false);
    expect((await secondPage.request.get(`/api/chats/${created.chat.id}`)).status()).toBe(404);
  } finally {
    await firstPage?.context().close();
    await secondPage?.context().close();
    await prisma.user.deleteMany({
      where: {
        email: {
          endsWith: `@${domain}`
        }
      }
    });
    await prisma.group.deleteMany({
      where: {
        id: group.id
      }
    });
  }
});
