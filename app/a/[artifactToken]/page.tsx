import type { Metadata } from "next";
import { cache } from "react";
import { unstable_noStore as noStore } from "next/cache";
import { notFound } from "next/navigation";
import { PublicArtifactView } from "@/components/artifacts/PublicArtifactView";
import { createArtifactService } from "@/lib/server/artifacts/service";
import { prisma } from "@/lib/server/prisma";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
const service = createArtifactService(prisma, createS3StorageAdapter());
const loadPublicArtifact = cache((token: string) => service.publicManifest(token).catch(() => null));

export async function generateMetadata({ params }: { params: Promise<{ artifactToken: string }> }): Promise<Metadata> {
  noStore();
  const { artifactToken } = await params;
  const result = await loadPublicArtifact(artifactToken);
  return { title: { absolute: result ? `${result.title} · AIQSA` : "AIQSA" }, robots: { follow: false, index: false, nocache: true }, referrer: "no-referrer" };
}

export default async function PublicArtifactPage({ params }: { params: Promise<{ artifactToken: string }> }) {
  noStore();
  const { artifactToken } = await params;
  const result = await loadPublicArtifact(artifactToken);
  if (!result) notFound();
  return <PublicArtifactView key={artifactToken} initialManifest={result} token={artifactToken} />;
}
