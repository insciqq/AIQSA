export function AdminFeedbackMessages({
  error,
  notice
}: Readonly<{
  error: string | null;
  notice: string | null;
}>) {
  return (
    <>
      {notice ? (
        <p
          aria-live="polite"
          className="mt-3 break-words rounded-control bg-accent-green/10 px-3 py-2 text-sm text-accent-green [overflow-wrap:anywhere]"
          role="status"
        >
          {notice}
        </p>
      ) : null}

      {error ? (
        <p
          className="mt-3 break-words rounded-control bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose [overflow-wrap:anywhere]"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </>
  );
}
