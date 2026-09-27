import { authorizeChatPage, chatPageQuery, type ChatPageSearchParams } from "../../../../viewer";

export default async function ProjectChatPage({
  params,
  searchParams
}: Readonly<{ params: Promise<{ chatId: string; projectId: string }>; searchParams: ChatPageSearchParams }>) {
  const [{ chatId, projectId }, query] = await Promise.all([params, searchParams]);
  await authorizeChatPage(
    `/p/${encodeURIComponent(projectId)}/c/${encodeURIComponent(chatId)}`,
    chatPageQuery(query)
  );
  return null;
}
