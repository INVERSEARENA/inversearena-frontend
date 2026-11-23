/**
 * Auth Metrics Domain (#1750)
 */

import { createCounter } from "../registry";

export const aliasUpdateTotal = createCounter(
  {
    name: "inversearena_alias_updates_total",
    help: "Total alias update attempts by result",
    labelNames: ["result"],
  },
  { domain: "auth" },
);
