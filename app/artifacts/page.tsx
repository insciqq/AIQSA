import Link from "next/link";
import { ArtifactLibrary } from "@/components/artifacts/ArtifactLibrary";

export const dynamic = "force-dynamic";

export default function ArtifactsPage() {
  return <main className="min-h-dvh bg-answer-paper text-ink">
    <header className="flex min-h-14 items-center justify-between border-b border-trace-subtle bg-workspace-rail px-4 sm:px-6">
      <Link className="v2-focusable text-sm font-semibold" href="/">AIQSA</Link>
      <Link className="v2-focusable text-sm text-ink-secondary" href="/">Back to chat</Link>
    </header>
    <section className="mx-auto max-w-5xl p-4 sm:p-6"><ArtifactLibrary /></section>
  </main>;
}
