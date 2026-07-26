import { AdminPanel } from "@/components/admin/AdminPanel";
import { getAuthConfig } from "@/lib/server/auth/config";
import { authSessionStore } from "@/lib/server/auth/defaultAuth";
import { resolveAuthToken } from "@/lib/server/auth/requestAuth";
import { SESSION_COOKIE_NAME } from "@/lib/server/auth/session";
import { prisma } from "@/lib/server/prisma";
import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default async function AdminPage() {
  const config = getAuthConfig();

  if (!config.configured) {
    redirect("/login?next=/admin");
  }

  const cookieStore = await cookies();
  const session = await resolveAuthToken(cookieStore.get(SESSION_COOKIE_NAME)?.value, {
    sessions: authSessionStore
  });

  if (!session) {
    redirect("/login?next=/admin");
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
    redirect("/login?next=/admin");
  }

  if (user.role !== "admin") {
    return (
      <main className="min-h-[100dvh] overflow-x-hidden bg-research-canvas pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(1rem,env(safe-area-inset-top))] text-ink">
        <section
          className="mx-auto flex max-w-[720px] items-start gap-3 border-t border-critical bg-answer-paper px-1 py-5 sm:px-4"
          data-testid="admin-denied"
        >
          <div className="grid size-9 shrink-0 place-items-center rounded-control bg-critical/10 text-critical">
            <ShieldAlert className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold">Admin access required</h1>
            <p className="mt-1 text-sm text-ink-secondary">
              Signed-in users without the admin role cannot view user-management data.
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

  return <AdminPanel adminEmail={user.email ?? user.displayName} adminUserId={session.userId} />;
}
