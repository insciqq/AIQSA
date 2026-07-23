import { timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { readCookie } from "@/lib/server/auth/session";
import type { McpOAuthFlowBinding } from "./oauthService";

export const MCP_OAUTH_FLOW_COOKIE_NAME = "aiqsa_mcp_oauth_flow";
export const MCP_OAUTH_FLOW_MAX_AGE_SECONDS = 10 * 60;

const FLOW_STRING_LIMITS: Record<keyof McpOAuthFlowBinding, number> = {
  clientId: 2_048,
  codeVerifier: 512,
  configurationIdentity: 256,
  oauthClientId: 128,
  policyFingerprint: 128,
  purpose: 16,
  redirectUri: 2_048,
  registrationKey: 128,
  serverId: 128,
  state: 512,
  userId: 128
};

function validFlow(value: unknown): value is McpOAuthFlowBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.purpose !== "user" && record.purpose !== "validation") return false;
  return (Object.keys(FLOW_STRING_LIMITS) as Array<keyof McpOAuthFlowBinding>).every((key) => {
    const candidate = record[key];
    return typeof candidate === "string" && candidate.length > 0 &&
      candidate.length <= FLOW_STRING_LIMITS[key];
  });
}

function exactFlow(value: McpOAuthFlowBinding): McpOAuthFlowBinding {
  return {
    clientId: value.clientId,
    codeVerifier: value.codeVerifier,
    configurationIdentity: value.configurationIdentity,
    oauthClientId: value.oauthClientId,
    policyFingerprint: value.policyFingerprint,
    purpose: value.purpose,
    redirectUri: value.redirectUri,
    registrationKey: value.registrationKey,
    serverId: value.serverId,
    state: value.state,
    userId: value.userId
  };
}

export function exactMcpOAuthState(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export async function signMcpOAuthFlow(input: Readonly<{
  flow: McpOAuthFlowBinding;
  now: Date;
  sessionSecret: string;
}>): Promise<string> {
  return new SignJWT({ ...input.flow })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(Math.floor(input.now.getTime() / 1_000))
    .setExpirationTime(Math.floor(input.now.getTime() / 1_000) + MCP_OAUTH_FLOW_MAX_AGE_SECONDS)
    .sign(new TextEncoder().encode(input.sessionSecret));
}

export async function readMcpOAuthFlow(input: Readonly<{
  now: Date;
  request: Request;
  sessionSecret: string;
}>): Promise<McpOAuthFlowBinding | null> {
  const token = readCookie(input.request.headers.get("cookie"), MCP_OAUTH_FLOW_COOKIE_NAME);
  if (!token) return null;
  try {
    const verified = await jwtVerify(token, new TextEncoder().encode(input.sessionSecret), {
      algorithms: ["HS256"],
      currentDate: input.now,
      maxTokenAge: `${MCP_OAUTH_FLOW_MAX_AGE_SECONDS}s`
    });
    return validFlow(verified.payload) ? exactFlow(verified.payload) : null;
  } catch {
    return null;
  }
}

export function mcpOAuthFlowCookie(input: Readonly<{
  maxAge: number;
  secure: boolean;
  value: string;
}>): string {
  const attributes = [
    `${MCP_OAUTH_FLOW_COOKIE_NAME}=${input.value}`,
    "Path=/api",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${input.maxAge}`
  ];
  if (input.secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearMcpOAuthFlowCookie(secure: boolean): string {
  return mcpOAuthFlowCookie({ maxAge: 0, secure, value: "" });
}
