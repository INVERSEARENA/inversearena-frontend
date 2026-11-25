/**
 * Brotli or gzip for JSON responses over a size threshold (#1767).
 *
 * SSE is not compressed. Compressing an event stream and letting a proxy
 * buffer it delays frames until the compressor flushes, which stalls the
 * arena stream. Routes that ask for `text/event-stream`, or whose path
 * contains `/stream`, are passed through untouched.
 */

import zlib from "node:zlib";
import type { NextFunction, Request, Response } from "express";

export const COMPRESSION_THRESHOLD_BYTES = 1024;

export function selectEncoding(acceptEncoding: string | undefined): "br" | "gzip" | null {
  const accept = acceptEncoding ?? "";
  if (/\bbr\b/.test(accept)) return "br";
  if (/\bgzip\b/.test(accept)) return "gzip";
  return null;
}

export function isEventStreamRequest(req: Pick<Request, "headers" | "path">): boolean {
  const accept = String(req.headers.accept ?? "");
  if (accept.includes("text/event-stream")) return true;
  return req.path.includes("/stream");
}

export function responseCompression(req: Request, res: Response, next: NextFunction): void {
  if (isEventStreamRequest(req)) {
    next();
    return;
  }
  const encoding = selectEncoding(req.header("accept-encoding"));
  if (!encoding) {
    next();
    return;
  }

  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    const payload = Buffer.from(JSON.stringify(body));
    if (payload.length < COMPRESSION_THRESHOLD_BYTES) {
      return originalJson(body);
    }
    const compressed =
      encoding === "br" ? zlib.brotliCompressSync(payload) : zlib.gzipSync(payload);
    if (compressed.length >= payload.length) {
      return originalJson(body);
    }
    res.setHeader("Content-Encoding", encoding);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Vary", "Accept-Encoding");
    res.setHeader("Content-Length", compressed.length);
    res.send(compressed);
    return res;
  };
  next();
}
