import { authorizeChatPage, chatPageQuery, type ChatPageSearchParams } from "../../viewer";

export default async function ChatPage({
  params,
  searchParams
}: Readonly<{ params: Promise<{ chatId: string }>; searchParams: ChatPageSearchParams }>) {
  const [{ chatId }, query] = await Promise.all([params, searchParams]);
  await authorizeChatPage(`/c/${encodeURIComponent(chatId)}`, chatPageQuery(query));
  return null;
}
