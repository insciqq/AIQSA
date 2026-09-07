import { EmptyState, quietButton } from "@/components/admin/adminPrimitives";

export function AdminDashboardUnavailable({
  loading,
  onRetry
}: Readonly<{
  loading: boolean;
  onRetry?(): void;
}>) {
  if (loading) {
    return <EmptyState title="Loading admin data" detail="Fetching the current users, groups, invites, and grants." />;
  }
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10">
      <EmptyState title="Admin data unavailable" detail="Check the error message, then try again." />
      {onRetry ? (
        <button className={quietButton} onClick={onRetry} type="button">
          Try again
        </button>
      ) : null}
    </div>
  );
}
