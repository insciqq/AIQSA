/** One provider request; independent Search, tool and Agent budgets still apply. */
export const providerResponseTimeoutSeconds = Object.freeze({
  default: 300,
  minimum: 5,
  maximum: 24 * 60 * 60
});
