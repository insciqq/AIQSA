import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

export const TRACE_HEADER: "x-aiqsa-trace-id";
export const SLOW_REQUEST_MS: 2000;
export type ResolvedRoute = Readonly<{
  routePath?: string;
  route_source: "manifest" | "unknown";
}>;
export type RouteResolver = (url: string | undefined) => ResolvedRoute;
export function createRouteResolver(manifest: unknown): RouteResolver;
export function loadRouteResolver(manifestPath: string): RouteResolver;
export function reportNextRequestError(method: string, routePath: string): void;
export function wrapHttpListener(
  listener: (request: IncomingMessage, response: ServerResponse) => unknown,
  options?: Readonly<{
    resolver?: RouteResolver;
    stampRequest?: (request: IncomingMessage) => void;
  }>
): RequestListener;
export function runHttpHandler(
  request: Request,
  handler: (request: Request) => Response | Promise<Response>
): Promise<Response>;
