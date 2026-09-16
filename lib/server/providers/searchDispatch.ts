import type { ModelRunUsage } from "@/lib/domain/modelRunEvents";
import type { ProviderSearchOptions } from "./types";

/** One physical request, including provider-required continuations. */
export type ProviderSearchDispatch = <T>(input: Readonly<{
  body: unknown;
  execute(): Promise<T>;
  usage(value: T): ModelRunUsage;
}>) => Promise<T>;

export function dispatchSearchRequest<T>(options: ProviderSearchOptions,
  input: Readonly<{
    body: unknown;
    execute(): Promise<T>;
    usage(value: T): ModelRunUsage;
  }>): Promise<T> {
  return options.dispatch ? options.dispatch<T>(input) : input.execute();
}
