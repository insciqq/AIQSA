// Handler factories also accept resolved params for direct callers. The Next.js
// route export must describe the Promise-only context supplied by the framework.
export type AsyncRouteHandler<Handler> = Handler extends (
  request: infer RequestType,
  context: infer Context
) => infer Result
  ? Context extends { params: infer Params }
    ? (
        request: RequestType,
        context: Omit<Context, "params"> & { params: Promise<Awaited<Params>> }
      ) => Result
    : never
  : never;
