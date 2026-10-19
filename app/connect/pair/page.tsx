import { ConnectPairView } from "@/features/connect/ConnectPairView";
import type { Metadata } from "next";
import { authorizeChatPage, chatPageQuery, type ChatPageSearchParams } from "../../(chat)/viewer";

export const metadata: Metadata = {
  title: "Connect a computer"
};

/** The approval link `aiqsa-connect login` prints; sign-in returns here with the code. */
export default async function ConnectPairPage({ searchParams }: Readonly<{ searchParams: ChatPageSearchParams }>) {
  const query = chatPageQuery(await searchParams);
  await authorizeChatPage("/connect/pair", query);
  const codes = query.getAll("code");
  return <ConnectPairView code={codes.length === 1 ? codes[0]! : null} />;
}
