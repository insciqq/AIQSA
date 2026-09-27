import { legacyChatRouteHref } from "@/lib/domain/chatRoute";
import { redirect } from "next/navigation";
import { authorizeChatPage, chatPageQuery, type ChatPageSearchParams } from "./viewer";

/** `/` is always a new chat; legacy `?chat=`/`?project=` links move to their path form. */
export default async function NewChatPage({
  searchParams
}: Readonly<{ searchParams: ChatPageSearchParams }>) {
  const query = chatPageQuery(await searchParams);
  const legacy = legacyChatRouteHref(query);
  if (legacy) redirect(legacy);
  await authorizeChatPage("/", query);
  return null;
}
