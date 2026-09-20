import { ArtifactWorkbench } from "@/components/artifacts/ArtifactWorkbench";
import Link from "next/link";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function PrivateArtifactPage({ params }: { params: Promise<{ artifactId: string; versionId: string }> }) {
  const { artifactId, versionId } = await params;
  return (
    <main className="min-h-[100dvh] bg-answer-paper text-ink">
      <header className="flex min-h-14 items-center justify-between border-b border-trace-subtle bg-workspace-rail px-4 sm:px-6">
        <Link className="text-sm font-semibold text-ink" href="/">AIQSA</Link>
        <Link className="v2-focusable text-sm text-ink-secondary" href="/artifacts">Artifacts</Link>
      </header>
      <section className="mx-auto w-full max-w-[1200px] p-3 sm:p-6">
        <ArtifactWorkbench key={artifactId} artifactId={artifactId} versionId={versionId} />
      </section>
    </main>
  );
}
