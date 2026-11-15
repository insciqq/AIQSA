import { CONNECT_SETTINGS_PATH } from "@/lib/contracts/connect";
import { notFound, redirect } from "next/navigation";
import { authorizeChatPage, chatPageQuery, loadChatViewer, type ChatPageSearchParams } from "../(chat)/viewer";

/**
 * `/connect` was AIQSA Connect's own page; the user's computers now live in
 * Settings › Computers (operator decision 2026-11-16). Old links and
 * bookmarks sign in as before, then land there without their other query
 * parameters; with the feature off the address does not exist.
 */
export default async function ConnectPage({ searchParams }: Readonly<{ searchParams: ChatPageSearchParams }>) {
  await authorizeChatPage("/connect", chatPageQuery(await searchParams));
  if (!(await loadChatViewer())?.connectEnabled) notFound();
  redirect(CONNECT_SETTINGS_PATH);
}
