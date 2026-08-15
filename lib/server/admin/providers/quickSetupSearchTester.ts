import type {
  ProviderConnectionConfiguration,
  ProviderModelConfiguration
} from "../../providers/providerConfiguration";

export type AdminProviderQuickSetupSearchTestOutcome = Readonly<{
  normalizedSourceCount: number;
  status: "available" | "unavailable";
}>;

export type AdminProviderQuickSetupSearchTester = Readonly<{
  test(input: Readonly<{
    connection: ProviderConnectionConfiguration;
    model: ProviderModelConfiguration;
    secret: string;
    signal?: AbortSignal;
  }>): Promise<AdminProviderQuickSetupSearchTestOutcome>;
}>;
