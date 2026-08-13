import { PowerAppShellV2 } from "@/features/workspace-v2/PowerAppShellV2";
import { getAuthConfig } from "@/lib/server/auth/config";
import { authSessionStore } from "@/lib/server/auth/defaultAuth";
import { resolveAuthToken } from "@/lib/server/auth/requestAuth";
import { SESSION_COOKIE_NAME } from "@/lib/server/auth/session";
import { prisma } from "@/lib/server/prisma";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Chat"
};

export default async function Home() {
  const config = getAuthConfig();

  if (!config.configured) {
    redirect("/login");
  }

  const cookieStore = await cookies();
  const session = await resolveAuthToken(cookieStore.get(SESSION_COOKIE_NAME)?.value, {
    sessions: authSessionStore
  });

  if (!session) {
    redirect("/login");
  }

  const user = await prisma.user.findUnique({
    select: {
      email: true,
      role: true,
      status: true
    },
    where: {
      id: session.userId
    }
  });

  if (!user || user.status !== "active") {
    redirect("/login");
  }

  return (
    <PowerAppShellV2
      accountEmail={user.email}
      accountId={session.userId}
      adminEntryVisible={user.role === "admin"}
    />
  );
}
