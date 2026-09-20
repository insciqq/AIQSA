/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { Download, ExternalLink, Lock } from "lucide-react";

export function PublicArtifactView({ body, contentType, kind, title, token }: {
  body: string;
  contentType: string;
  kind: string;
  title: string;
  token: string;
}) {
  const image = contentType.startsWith("image/");
  return (
    <main className="min-h-[100dvh] bg-answer-paper text-ink">
      <header className="border-b border-trace-subtle bg-workspace-rail pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex min-h-14 max-w-[1200px] items-center justify-between gap-4 px-4 sm:min-h-16 sm:px-6">
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-[0.01em] text-ink">AIQSA</p>
            <p className="truncate text-xs text-ink-muted">Public artifact · {kind}</p>
          </div>
          <div className="flex shrink-0 items-center gap-3 text-xs text-ink-secondary">
            <span className="hidden items-center gap-1.5 sm:inline-flex"><Lock className="size-3.5" aria-hidden="true" />Read-only snapshot</span>
            <a className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-trace-subtle px-3 font-medium text-ink transition-colors hover:border-control-accent hover:text-control-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-control-accent" href={`/api/artifact-public/${encodeURIComponent(token)}?download=zip`}>
              <Download className="size-3.5" aria-hidden="true" />Download
            </a>
          </div>
        </div>
      </header>
      <section className="mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-[1200px] flex-col px-3 py-4 sm:px-6 sm:py-6">
        <div className="mb-4 flex items-center justify-between gap-4">
          <h1 className="min-w-0 break-words text-lg font-semibold text-ink sm:text-xl">{title}</h1>
          <Link className="inline-flex shrink-0 items-center gap-1.5 text-xs text-ink-muted hover:text-control-accent" href="/">
            Open AIQSA <ExternalLink className="size-3.5" aria-hidden="true" />
          </Link>
        </div>
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-trace-subtle bg-answer-paper">
          {image ? <img alt={title} className="mx-auto block h-full max-h-[calc(100dvh-9rem)] max-w-full object-contain" src={`data:${contentType};base64,${body}`} /> :
            <iframe
              aria-label={title}
              className="min-h-[70dvh] w-full flex-1 self-stretch border-0"
              sandbox="allow-scripts"
              srcDoc={body}
              title={title}
            />}
        </div>
      </section>
    </main>
  );
}
