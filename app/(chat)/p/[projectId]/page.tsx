import { authorizeChatPage, chatPageQuery, type ChatPageSearchParams } from "../../viewer";

export default async function ProjectChatPage({
  params,
  searchParams
}: Readonly<{ params: Promise<{ projectId: string }>; searchParams: ChatPageSearchParams }>) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  await authorizeChatPage(`/p/${encodeURIComponent(projectId)}`, chatPageQuery(query));
  return null;
}
