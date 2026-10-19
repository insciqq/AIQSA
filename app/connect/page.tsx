import { ConnectHomeView } from "@/features/connect/ConnectHomeView";
import { authorizeChatPage, chatPageQuery, type ChatPageSearchParams } from "../(chat)/viewer";

export default async function ConnectPage({ searchParams }: Readonly<{ searchParams: ChatPageSearchParams }>) {
  await authorizeChatPage("/connect", chatPageQuery(await searchParams));
  return <ConnectHomeView />;
}
