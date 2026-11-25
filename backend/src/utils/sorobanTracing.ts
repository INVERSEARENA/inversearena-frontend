import {
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from "@opentelemetry/api";

const sorobanTracer = trace.getTracer("inversearena-backend.soroban-rpc");

export interface SorobanRpcSpanOptions {
  method: string;
  contractId?: string;
  fn?: string;
  ledger?: number;
}

/**
 * Sets the `soroban.ledger` attribute on an active Soroban RPC span when a
 * valid ledger sequence is known.
 */
export function setSorobanSpanLedger(span: Span, ledger: unknown): void {
  if (typeof ledger === "number" && Number.isFinite(ledger) && ledger >= 0) {
    span.setAttribute("soroban.ledger", Math.floor(ledger));
  }
}

/**
 * Wraps an outbound Soroban RPC call in a manual OpenTelemetry CLIENT span
 * with `soroban.rpc.method`, `soroban.contract_id`, `soroban.function`, and
 * `soroban.ledger` attributes.
 *
 * Never accepts or records wallet secrets or signed XDR payloads.
 */
export async function withSorobanRpcSpan<T>(
  options: SorobanRpcSpanOptions,
  run: (span: Span) => Promise<T>,
): Promise<T> {
  const attributes: Attributes = {
    "rpc.system": "soroban",
    "soroban.rpc.method": options.method,
  };
  if (options.contractId) {
    attributes["soroban.contract_id"] = options.contractId;
  }
  if (options.fn) {
    attributes["soroban.function"] = options.fn;
  }
  if (typeof options.ledger === "number" && Number.isFinite(options.ledger) && options.ledger >= 0) {
    attributes["soroban.ledger"] = Math.floor(options.ledger);
  }

  return sorobanTracer.startActiveSpan(
    `soroban.rpc.${options.method}`,
    { kind: SpanKind.CLIENT, attributes },
    async (span) => {
      try {
        const result = await run(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        if (error instanceof Error) {
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        } else {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
        }
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
