import { AdminPanel } from "@/components/admin/AdminPanel";
import { chatReturnPath } from "@/lib/domain/chatRoute";
import { getAuthConfig } from "@/lib/server/auth/config";
import { authSessionStore } from "@/lib/server/auth/defaultAuth";
import { resolveAuthToken } from "@/lib/server/auth/requestAuth";
import { SESSION_COOKIE_NAME } from "@/lib/server/auth/session";
import { prisma } from "@/lib/server/prisma";
import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Control Center"
};

type AdminPageSearchParams = Record<string, string | string[] | undefined>;

type AdminPageProps = Readonly<{
  searchParams?: Promise<AdminPageSearchParams>;
}>;

/** Sign-in returns to the same Control Center address, including its `return` chat route. */
function adminLoginHref(params: AdminPageSearchParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      query.append(key, entry);
    }
  }
  return query.size > 0
    ? `/login?${new URLSearchParams({ next: `/admin?${query}` })}`
    : "/login?next=/admin";
}

export default async function AdminPage({ searchParams }: AdminPageProps = {}) {
  const params = (await searchParams) ?? {};
  const config = getAuthConfig();
  const loginHref = adminLoginHref(params);

  if (!config.configured) {
    redirect(loginHref);
  }

  const cookieStore = await cookies();
  const session = await resolveAuthToken(cookieStore.get(SESSION_COOKIE_NAME)?.value, {
    sessions: authSessionStore
  });

  if (!session) {
    redirect(loginHref);
  }

  const user = await prisma.user.findUnique({
    select: {
      displayName: true,
      email: true,
      role: true,
      status: true
    },
    where: {
      id: session.userId
    }
  });

  if (!user || user.status !== "active") {
    redirect(loginHref);
  }

  if (user.role !== "admin") {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center overflow-x-hidden bg-app-canvas pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(1rem,env(safe-area-inset-top))] text-ink">
        <section
          className="flex w-full max-w-[720px] items-start gap-3 border-t border-critical bg-answer-paper px-1 py-5 sm:px-4"
          data-testid="admin-denied"
        >
          <div className="grid size-9 shrink-0 place-items-center rounded-control bg-critical/10 text-critical">
            <ShieldAlert className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold">Admin access required</h1>
            <p className="mt-1 text-sm text-ink-secondary">
              Only administrators can open the Control Center and manage access, providers, tools, email delivery, and other installation settings.
            </p>
            <Link
              className="mt-4 inline-flex min-h-touch items-center rounded-control bg-control-surface px-4 text-sm font-medium text-ink hover:bg-control-hover"
              href="/"
            >
              Return to workspace
            </Link>
          </div>
        </section>
      </main>
    );
  }

  // Validated here so the first server render already links back to the origin chat.
  const requestedReturn = params.return;
  return (
    <AdminPanel
      accountLabel={user.displayName.trim() || user.email}
      adminEmail={user.email ?? user.displayName}
      adminUserId={session.userId}
      returnPath={chatReturnPath(typeof requestedReturn === "string" ? requestedReturn : null)}
    />
  );
}
