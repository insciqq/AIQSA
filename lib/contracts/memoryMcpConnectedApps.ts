import { z } from "zod";

export const MEMORY_MCP_CONNECTED_APPS_MAX = 100;

const connectionIdSchema = z.string()
  .min(1)
  .max(128)
  .refine(
    (value) => !/[\u0000-\u0020\u007f]/u.test(value),
    "invalid connection id"
  );
const clientNameSchema = z.string()
  .min(1)
  .max(200)
  .refine((value) => value.trim().length > 0, "client name is blank")
  .refine((value) => !value.includes("\u0000"), "client name contains a null byte");
const forbiddenOpaqueOriginSchemes = new Set([
  "data:",
  "file:",
  "ftp:",
  "http:",
  "https:",
  "javascript:"
]);
const clientOriginSchema = z.string().min(1).max(2_048).refine((value) => {
  if (/^[a-z][a-z0-9+.-]*:$/u.test(value)) {
    return !forbiddenOpaqueOriginSchemes.has(value);
  }
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === value && !url.username && !url.password;
  } catch {
    return false;
  }
}, "invalid client origin");
const isoTimestampSchema = z.string().max(64).refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}, "invalid ISO timestamp");

export const memoryMcpConnectedAppSchema = z.strictObject({
  connectionId: connectionIdSchema,
  clientName: clientNameSchema,
  clientOrigin: clientOriginSchema,
  connectedAt: isoTimestampSchema,
  lastUsedAt: isoTimestampSchema.nullable(),
  revokedAt: isoTimestampSchema.nullable(),
  state: z.enum(["ACTIVE", "REVOKED"])
}).superRefine((app, context) => {
  if (app.state === "ACTIVE" && app.revokedAt !== null) {
    context.addIssue({ code: "custom", message: "active app has revokedAt" });
  }
  if (app.state === "REVOKED" && app.revokedAt === null) {
    context.addIssue({ code: "custom", message: "revoked app lacks revokedAt" });
  }
});

export const memoryMcpConnectedAppsResponseSchema = z.strictObject({
  apps: z.array(memoryMcpConnectedAppSchema).max(MEMORY_MCP_CONNECTED_APPS_MAX)
});

export const memoryMcpConnectedAppResponseSchema = z.strictObject({
  app: memoryMcpConnectedAppSchema
});

export type MemoryMcpConnectedApp = z.infer<typeof memoryMcpConnectedAppSchema>;
export type MemoryMcpConnectedAppsResponse = z.infer<
  typeof memoryMcpConnectedAppsResponseSchema
>;

export function decodeMemoryMcpConnectedAppsResponse(
  value: unknown
): MemoryMcpConnectedAppsResponse | null {
  const decoded = memoryMcpConnectedAppsResponseSchema.safeParse(value);
  return decoded.success ? decoded.data : null;
}

export function decodeMemoryMcpConnectedAppResponse(
  value: unknown
): Readonly<{ app: MemoryMcpConnectedApp }> | null {
  const decoded = memoryMcpConnectedAppResponseSchema.safeParse(value);
  return decoded.success ? decoded.data : null;
}

export function decodeMemoryMcpConnectionId(value: unknown): string | null {
  const decoded = connectionIdSchema.safeParse(value);
  return decoded.success ? decoded.data : null;
}
