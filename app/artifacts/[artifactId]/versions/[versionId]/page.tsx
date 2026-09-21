import { ArtifactPageV2 } from "@/components/artifacts/ArtifactPageV2";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function PrivateArtifactPage({ params }: { params: Promise<{ artifactId: string; versionId: string }> }) {
  const { artifactId, versionId } = await params;
  return <ArtifactPageV2 artifactId={artifactId} versionId={versionId} />;
}
