import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import { notFound } from "next/navigation";
import { PublicArtifactView } from "@/components/artifacts/PublicArtifactView";
import { createArtifactService } from "@/lib/server/artifacts/service";
import { prisma } from "@/lib/server/prisma";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = { title: "Public artifact", robots: { follow: false, index: false, nocache: true } };
const service = createArtifactService(prisma, createS3StorageAdapter());

function base64(body: Buffer): string { return body.toString("base64"); }

export default async function PublicArtifactPage({ params }: { params: Promise<{ artifactToken: string }> }) {
  noStore();
  const { artifactToken } = await params;
  const result = await service.publicBundle(artifactToken).catch(() => null);
  if (!result) notFound();
  const isImage = result.contentType.startsWith("image/");
  return <PublicArtifactView body={isImage ? base64(result.body) : result.body.toString("utf8")} contentType={result.contentType} kind={String(result.kind)} title={result.title} token={artifactToken} />;
}
