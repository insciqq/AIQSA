import type { ModelRunUsage } from "@/lib/domain/modelRunEvents";
import type { ProviderSearchOptions } from "./types";

/** One physical request, including provider-required continuations. `cost`
 * reads what the provider reported the request cost, when it reports one. */
export type ProviderSearchDispatch = <T>(input: Readonly<{
  body: unknown;
  cost?(value: T): number | null;
  execute(): Promise<T>;
  usage(value: T): ModelRunUsage;
}>) => Promise<T>;

export function dispatchSearchRequest<T>(options: ProviderSearchOptions,
  input: Readonly<{
    body: unknown;
    cost?(value: T): number | null;
    execute(): Promise<T>;
    usage(value: T): ModelRunUsage;
  }>): Promise<T> {
  return options.dispatch ? options.dispatch<T>(input) : input.execute();
}
