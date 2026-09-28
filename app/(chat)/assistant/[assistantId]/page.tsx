import { formatAssistantEntryPath } from "@/lib/domain/chatRoute";
import { authorizeChatPage, chatPageQuery, type ChatPageSearchParams } from "../../viewer";

export default async function AssistantEntryPage({
  params,
  searchParams
}: Readonly<{ params: Promise<{ assistantId: string }>; searchParams: ChatPageSearchParams }>) {
  const [{ assistantId }, query] = await Promise.all([params, searchParams]);
  await authorizeChatPage(formatAssistantEntryPath(assistantId), chatPageQuery(query));
  return null;
}
