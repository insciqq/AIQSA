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
          className="mt-3 break-words border-l-2 border-positive bg-positive/10 px-3 py-2 text-sm text-positive [overflow-wrap:anywhere]"
          role="status"
        >
          {notice}
        </p>
      ) : null}

      {error ? (
        <p
          className="mt-3 break-words border-l-2 border-critical bg-critical/10 px-3 py-2 text-sm text-critical [overflow-wrap:anywhere]"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </>
  );
}
