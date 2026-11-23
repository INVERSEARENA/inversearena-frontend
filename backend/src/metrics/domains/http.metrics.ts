/**
 * HTTP Metrics Domain (#1750)
 */

import { createCounter, createHistogram } from "../registry";

export const httpRequestsTotal = createCounter(
  {
    name: "http_requests_total",
    help: "Total number of HTTP requests",
    labelNames: ["method", "route", "status"],
  },
  { domain: "http" },
);

export const httpRequestDuration = createHistogram(
  {
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route", "status"],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  },
  { domain: "http" },
);
