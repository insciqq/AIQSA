import { ConnectSessionNotFound, ConnectSessionView } from "@/features/connect/ConnectSessionView";
import { CONNECT_ID_PATTERN, CONNECT_SESSION_ID_PATTERN } from "@/lib/contracts/connect";
import { authorizeChatPage, chatPageQuery, type ChatPageSearchParams } from "../../../(chat)/viewer";

export default async function ConnectSessionPage({
  params,
  searchParams
}: Readonly<{ params: Promise<{ deviceId: string; sessionId: string }>; searchParams: ChatPageSearchParams }>) {
  const [{ deviceId, sessionId }, query] = await Promise.all([params, searchParams]);
  await authorizeChatPage(
    `/connect/${encodeURIComponent(deviceId)}/${encodeURIComponent(sessionId)}`,
    chatPageQuery(query)
  );
  // Malformed ids answer exactly like unknown ones, without asking the server.
  if (!CONNECT_ID_PATTERN.test(deviceId) || !CONNECT_SESSION_ID_PATTERN.test(sessionId)) {
    return <ConnectSessionNotFound />;
  }
  return <ConnectSessionView deviceId={deviceId} key={`${deviceId}/${sessionId}`} sessionId={sessionId} />;
}
