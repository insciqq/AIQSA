import { EmptyState } from "@/components/admin/adminPrimitives";

export function AdminDashboardUnavailable({ loading }: Readonly<{ loading: boolean }>) {
  return loading ? (
    <EmptyState title="Loading admin data" detail="Fetching the current users, groups, invites, and grants." />
  ) : (
    <EmptyState title="Admin data unavailable" detail="Use Refresh after checking the error message above." />
  );
}
