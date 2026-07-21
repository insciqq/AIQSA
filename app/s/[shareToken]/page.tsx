import { notFound } from "next/navigation";
import { PublicShareView } from "@/components/share/PublicShareView";
import { createPrismaShareRepository } from "@/lib/server/shares/prismaRepository";
import { hashShareToken } from "@/lib/server/shares/tokens";

export const runtime = "nodejs";

const repository = createPrismaShareRepository();

export default async function PublicSharePage({
  params
}: {
  params: Promise<{ shareToken: string }> | { shareToken: string };
}) {
  const resolved = await params;
  const share = await repository.findPublicShare(hashShareToken(resolved.shareToken), new Date());

  if (!share) {
    notFound();
  }

  return <PublicShareView snapshot={share.snapshot} title={share.title} />;
}
