export const databaseRequiredTestFiles = [
  "lib/server/auth/adminDashboardQueries.test.ts",
  "lib/server/auth/adminRepository.test.ts",
  "lib/server/auth/oauthRepository.test.ts",
  "lib/server/auth/passwordRepository.test.ts",
  "lib/server/auth/registrationRepository.test.ts",
  "lib/server/chats/prismaRepository.test.ts",
  "lib/server/messages/prismaRepository.test.ts",
  "lib/server/prompts/prismaRepository.test.ts",
  "lib/server/prompts/promptDefaultConcurrency.test.ts",
  "lib/server/retention/prune.prisma.test.ts",
  "lib/server/runs/prismaRepository.test.ts",
  "lib/server/settings/prismaRepository.test.ts"
] as const;
