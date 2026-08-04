import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import { notFound } from "next/navigation";
import { PublicShareView } from "@/components/share/PublicShareView";
import { createPrismaShareRepository } from "@/lib/server/shares/prismaRepository";
import { hashShareToken } from "@/lib/server/shares/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "Shared research",
  robots: {
    follow: false,
    index: false,
    nocache: true
  }
};

const repository = createPrismaShareRepository();

export default async function PublicSharePage({
  params
}: {
  params: Promise<{ shareToken: string }> | { shareToken: string };
}) {
  noStore();
  const resolved = await params;
  const share = await repository.findPublicShare(hashShareToken(resolved.shareToken), new Date());

  if (!share) {
    notFound();
  }

  return <PublicShareView snapshot={share.snapshot} title={share.title} />;
}
