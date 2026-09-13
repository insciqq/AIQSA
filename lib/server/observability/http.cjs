"use strict";

const fs = require("node:fs");
const { performance } = require("node:perf_hooks");
const {
  bindContext,
  getContext,
  logEvent,
  registerRouteTemplates,
  runInBackground
} = require("./runtime.cjs");

const TRACE_HEADER = "x-aiqsa-trace-id";
const SLOW_REQUEST_MS = 2_000;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_ROUTES = 10_000;
const MAX_PATHNAME_LENGTH = 8_192;
const MAX_REGEX_LENGTH = 4_096;
const TEMPLATE_PATTERN = /^\/(?:[A-Za-z0-9_@.()\[\]-]+\/?)*$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"]);
const MUTATIONS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PRE_ADMISSION_STATUSES = new Set([401, 403, 404, 405, 413, 415, 429]);
const FAILURE_WINDOW_MS = 30_000;
const MAX_FAILURE_KEYS = 256;
const HTTP_STATE = Symbol.for("aiqsa.observability.http.v1");
const shared = globalThis[HTTP_STATE] ??= { resolverWarned: false, failures: new Map() };
const UNKNOWN_ROUTE = Object.freeze({ route_source: "unknown" });

function safeMethod(value) {
  return METHODS.has(value) ? value : "unknown";
}

function isRouteTemplate(value) {
  return typeof value === "string" && value.length <= 512 && TEMPLATE_PATTERN.test(value);
}

// The input is used only for matching/classification. It is never a log field.
function requestPathname(value) {
  if (typeof value !== "string" || value.length > MAX_PATHNAME_LENGTH || !value.startsWith("/") || value.startsWith("//") || /[\u0000-\u0020\u007f\\#]/.test(value)) {
    return null;
  }
  const pathname = value.split("?", 1)[0];
  try {
    decodeURIComponent(pathname);
    return pathname;
  } catch {
    return null;
  }
}

function warnResolver(reason) {
  if (shared.resolverWarned) return;
  shared.resolverWarned = true;
  logEvent("http.route_resolver_unavailable", { reason });
}

function createRouteResolver(manifest) {
  if (!manifest || typeof manifest !== "object" || manifest.version !== 3 ||
      typeof manifest.caseSensitive !== "boolean" || typeof manifest.basePath !== "string" ||
      (manifest.basePath !== "" && (!isRouteTemplate(manifest.basePath) || manifest.basePath.endsWith("/"))) ||
      !Array.isArray(manifest.staticRoutes) || !Array.isArray(manifest.dynamicRoutes) ||
      manifest.staticRoutes.length + manifest.dynamicRoutes.length > MAX_MANIFEST_ROUTES) {
    throw new Error("unsupported_routes_manifest");
  }
  const routes = [];
  for (const route of [...manifest.staticRoutes, ...manifest.dynamicRoutes]) {
    if (!route || typeof route !== "object") throw new Error("invalid_routes_manifest");
    if (route.skipInternalRouting === true) continue;
    if (!isRouteTemplate(route.page) || typeof route.regex !== "string" ||
        route.regex.length > MAX_REGEX_LENGTH || !route.regex.startsWith("^") || !route.regex.endsWith("$") ||
        (route.skipInternalRouting !== undefined && route.skipInternalRouting !== false)) {
      throw new Error("invalid_routes_manifest");
    }
    routes.push({ page: route.page, regex: new RegExp(route.regex, manifest.caseSensitive ? "" : "i") });
  }
  registerRouteTemplates(routes.map((route) => route.page));
  const basePath = manifest.basePath;
  const comparableBase = manifest.caseSensitive ? basePath : basePath.toLowerCase();
  return (url) => {
    let pathname = requestPathname(url);
    if (pathname === null) return UNKNOWN_ROUTE;
    const comparablePath = manifest.caseSensitive ? pathname : pathname.toLowerCase();
    if (basePath) {
      if (comparablePath !== comparableBase && !comparablePath.startsWith(`${comparableBase}/`)) return UNKNOWN_ROUTE;
      pathname = pathname.slice(basePath.length) || "/";
    }
    for (const route of routes) {
      if (route.regex.test(pathname)) return { routePath: route.page, route_source: "manifest" };
    }
    return UNKNOWN_ROUTE;
  };
}

function loadRouteResolver(manifestPath) {
  try {
    const stat = fs.statSync(manifestPath);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
      warnResolver("invalid");
      return () => UNKNOWN_ROUTE;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest?.version !== 3 || !Array.isArray(manifest.staticRoutes) || !Array.isArray(manifest.dynamicRoutes)) {
      warnResolver("unsupported");
      return () => UNKNOWN_ROUTE;
    }
    return createRouteResolver(manifest);
  } catch (error) {
    warnResolver(error?.code === "ENOENT" ? "missing" : "invalid");
    return () => UNKNOWN_ROUTE;
  }
}

function elapsed(started) {
  return Math.max(0, Math.round(performance.now() - started));
}

function isHealth(pathname) {
  return pathname !== null && /^\/api\/health(?:\/|$)/i.test(pathname);
}

function isQuietRead(pathname) {
  return pathname !== null && (
    /^\/_next\//i.test(pathname) ||
    /^\/(?:favicon(?:-alert)?\.(?:ico|svg)|icon(?:-\d+)?\.(?:png|svg)|apple-touch-icon\.png|sounds\/)/i.test(pathname) ||
    /^\/api\/chats\/[^/]+\/delete-permanently\/status\/?$/i.test(pathname) ||
    /^\/api\/uploads\/[^/]+\/?$/i.test(pathname) ||
    /^\/api\/me\/(?:catalog|knowledge-sources|knowledge-uploads\/[^/]+\/[^/]+\/[^/]+|knowledge-bases\/[^/]+\/upload-batches\/[^/]+)\/?$/i.test(pathname) ||
    /^\/api\/admin\/(?:attention|providers\/custom-setup|workspace\/overview)\/?$/i.test(pathname)
  );
}

function isSubstantialGet(pathname) {
  return pathname !== null && (
    /^\/api\/(?:me\/chats\/export|chats\/search)\/?$/i.test(pathname) ||
    /^\/api\/attachments\/[^/]+\/content\/?$/i.test(pathname) ||
    /^\/api\/chats\/[^/]+\/workspace\/(?:archive|exports)\/?$/i.test(pathname)
  );
}

function shouldReportPreAdmission(fields) {
  if (!PRE_ADMISSION_STATUSES.has(fields.status)) return true;
  const now = performance.now();
  const key = `${fields.method}:${fields.route_source}:${fields.routePath || "unknown"}:${fields.status}`;
  const previous = shared.failures.get(key);
  if (previous !== undefined && now - previous < FAILURE_WINDOW_MS) return false;
  if (shared.failures.size >= MAX_FAILURE_KEYS && !shared.failures.has(key)) {
    shared.failures.delete(shared.failures.keys().next().value);
  }
  shared.failures.set(key, now);
  return true;
}

function completeRequest(method, route, pathname, response, started, headersMs, outcome) {
  if (isHealth(pathname)) return;
  const durationMs = elapsed(started);
  const stream = /^text\/event-stream(?:;|$)/i.test(String(response.getHeader("content-type") || ""));
  const failed = response.statusCode >= 400 || (outcome === "closed" && !stream);
  if (!failed && (method === "GET" || method === "HEAD") && !stream && isQuietRead(pathname)) return;
  const slow = !stream && durationMs >= SLOW_REQUEST_MS;
  if (!failed && !slow && !MUTATIONS.has(method) && !stream && !isSubstantialGet(pathname)) return;
  const fields = {
    method,
    route_source: route.route_source,
    status: response.statusCode,
    duration_ms: durationMs,
    stream,
    outcome
  };
  if (route.routePath) fields.routePath = route.routePath;
  if (headersMs !== undefined) fields.headers_ms = headersMs;
  if (shouldReportPreAdmission(fields)) logEvent("http.request_completed", fields);
}

function listenerFailure(method, route, response) {
  const fields = { method, route_source: route.route_source, stage: "listener", error_category: "unexpected" };
  if (route.routePath) fields.routePath = route.routePath;
  logEvent("http.request_failed", fields);
  try {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.statusCode = 500;
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.end("Internal Server Error");
  } catch {
    // A disconnected/broken transport cannot carry the fallback response. Its
    // own error must not turn the original safe request failure into raw output.
    response.destroy();
  }
}

function wrapHttpListener(listener, options = {}) {
  const resolver = options.resolver || (() => UNKNOWN_ROUTE);
  return function observedHttpListener(request, response) {
    const receiver = this;
    return runInBackground(() => {
      const context = getContext();
      const started = performance.now();
      const route = resolver(request.url);
      const method = safeMethod(request.method);
      const pathname = route.routePath || requestPathname(request.url);
      let headersMs;
      let settled = false;
      // IncomingMessage's end/close events can originate in a socket resource
      // created before ALS.run. Bind the request-owned emitter so callbacks and
      // body adapters enter the same context as the initial listener.
      const emitRequest = request.emit;
      request.emit = bindContext(function emitObservedRequest(...args) {
        try {
          return Reflect.apply(emitRequest, this, args);
        } catch {
          listenerFailure(method, route, response);
          return false;
        }
      });
      response.setHeader(TRACE_HEADER, context.trace_id);
      const writeHead = response.writeHead;
      response.writeHead = function observedWriteHead(...args) {
        if (headersMs === undefined) headersMs = elapsed(started);
        const index = typeof args[1] === "string" ? 2 : 1;
        const headers = args[index];
        if (Array.isArray(headers)) {
          const normalized = [];
          for (let i = 0; i < headers.length; i += 2) {
            if (String(headers[i]).toLowerCase() !== TRACE_HEADER) normalized.push(headers[i], headers[i + 1]);
          }
          normalized.push(TRACE_HEADER, context.trace_id);
          args[index] = normalized;
        } else if (headers && typeof headers === "object") {
          const normalized = { ...headers };
          for (const name of Object.keys(normalized)) {
            if (name.toLowerCase() === TRACE_HEADER) delete normalized[name];
          }
          normalized[TRACE_HEADER] = context.trace_id;
          args[index] = normalized;
        }
        response.setHeader(TRACE_HEADER, context.trace_id);
        return Reflect.apply(writeHead, this, args);
      };
      const complete = bindContext((outcome) => {
        if (settled) return;
        settled = true;
        completeRequest(method, route, pathname, response, started, headersMs, outcome);
      });
      response.once("finish", () => complete("completed"));
      response.once("close", () => complete("closed"));
      try {
        if (options.stampRequest) options.stampRequest(request);
        const result = Reflect.apply(listener, receiver, [request, response]);
        if (result && typeof result.then === "function") {
          return Promise.resolve(result).catch(() => listenerFailure(method, route, response));
        }
        return result;
      } catch {
        listenerFailure(method, route, response);
      }
    });
  };
}

// Next owns errorContext.routePath. Never pass errorRequest.path, headers or the
// raw exception to this boundary, even when the route template is unavailable.
function reportNextRequestError(method, routePath) {
  const fields = {
    method: safeMethod(method),
    route_source: "unknown",
    stage: "next_request",
    error_category: "unexpected"
  };
  if (isRouteTemplate(routePath)) {
    registerRouteTemplates([routePath]);
    fields.routePath = routePath;
    fields.route_source = "next_error";
  }
  logEvent("http.request_failed", fields);
}

// Direct-handler tests enter the same root context and response-header boundary.
// Transport completion belongs to wrapHttpListener; this helper never reads or
// clones a response body to manufacture transport timing.
function runHttpHandler(request, handler) {
  return runInBackground(async () => {
    const traceId = getContext().trace_id;
    let response;
    try {
      response = await handler(request);
    } catch {
      logEvent("http.request_failed", {
        method: safeMethod(request.method),
        route_source: "unknown",
        stage: "listener",
        error_category: "unexpected"
      });
      response = new Response("Internal Server Error", { status: 500 });
    }
    try {
      response.headers.set(TRACE_HEADER, traceId);
      return response;
    } catch {
      const headers = new Headers(response.headers);
      headers.set(TRACE_HEADER, traceId);
      return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
    }
  });
}

module.exports = {
  TRACE_HEADER,
  SLOW_REQUEST_MS,
  createRouteResolver,
  loadRouteResolver,
  reportNextRequestError,
  runHttpHandler,
  wrapHttpListener
};
