import {
  DEFAULT_ADMIN_USAGE_PERIOD,
  isAdminUsagePeriod,
  type AdminUsageAnalyticsErrorCode,
  type AdminUsagePeriod
} from "@/lib/contracts/adminUsageAnalytics";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import { usageCsvLines, usageExportFilename } from "./csv";
import { UsageTimeZoneUnsupportedError, type AdminUsageRepository, type UsageExport } from "./repository";
import { usageDayKey, usageLocalDate, validUsageTimeZone } from "./window";

export type AdminUsageExportErrorCode = AdminUsageAnalyticsErrorCode | "usage_export_too_large";

const NO_STORE = { "cache-control": "private, no-store" } as const;
const LINES_PER_CHUNK = 500;

function reply(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function failure(code: AdminUsageExportErrorCode, status: number): Response {
  return reply({ error: code }, status);
}

type UsageQuery = Readonly<{ period: AdminUsagePeriod; timeZone: string }>;

/** A missing period means the default; a missing or non-IANA zone is invalid. */
function parseQuery(request: Request): UsageQuery | Response {
  const params = new URL(request.url).searchParams;
  const period = params.get("period") ?? DEFAULT_ADMIN_USAGE_PERIOD;
  if (!isAdminUsagePeriod(period)) return failure("usage_period_invalid", 400);
  const timeZone = validUsageTimeZone(params.get("tz"));
  return timeZone ? { period, timeZone } : failure("usage_time_zone_invalid", 400);
}

function csvStream(data: UsageExport): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = usageCsvLines({ models: data.models, rows: data.rows, users: data.users });
  let first = true;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      // A byte-order mark lets spreadsheet applications read UTF-8 names.
      let chunk = first ? "﻿" : "";
      first = false;
      for (let index = 0; index < LINES_PER_CHUNK; index += 1) {
        const next = lines.next();
        if (next.done) {
          if (chunk) controller.enqueue(encoder.encode(chunk));
          controller.close();
          return;
        }
        chunk += next.value;
      }
      controller.enqueue(encoder.encode(chunk));
    }
  });
}

export function createAdminUsageHandlers(input: Readonly<{
  now?: () => Date;
  repository: AdminUsageRepository;
  resolveAuth: RequestAuthResolver;
}>) {
  const now = input.now ?? (() => new Date());

  async function admitted(request: Request): Promise<UsageQuery | Response> {
    const auth = await input.resolveAuth(request);
    if (!auth) return failure("unauthorized", 401);
    if (auth.user.status !== "active" || auth.user.role !== "admin") return failure("forbidden", 403);
    return parseQuery(request);
  }

  async function guarded(request: Request, read: (query: UsageQuery, at: Date) => Promise<Response>): Promise<Response> {
    const query = await admitted(request);
    if (query instanceof Response) return query;
    try {
      return await read(query, now());
    } catch (error) {
      if (error instanceof UsageTimeZoneUnsupportedError) return failure("usage_time_zone_invalid", 400);
      console.error("usage_analytics_failed");
      return failure("usage_analytics_failed", 503);
    }
  }

  return {
    GET: (request: Request) => guarded(request, async (query, at) =>
      reply({ usage: await input.repository.readAnalytics({ ...query, now: at }) })),

    EXPORT: (request: Request) => guarded(request, async (query, at) => {
      const data = await input.repository.readExport({ ...query, now: at });
      if (!data) return failure("usage_export_too_large", 413);
      const filename = usageExportFilename(query.period, usageDayKey(usageLocalDate(at, query.timeZone)));
      return new Response(csvStream(data), {
        headers: {
          ...NO_STORE,
          "content-disposition": `attachment; filename="${filename}"`,
          "content-type": "text/csv; charset=utf-8",
          "x-content-type-options": "nosniff"
        }
      });
    })
  };
}
