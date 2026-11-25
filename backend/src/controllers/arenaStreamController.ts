/**
 * Arena Stream Controller (#1749).
 *
 * Owns Server-Sent Events (SSE) streaming lifecycle for real-time arena events.
 */

import type { Request, Response } from "express";
import { subscribeArena } from "../cache/arenaPoller";
import type { ArenaService } from "../services/arenaService";
import { arenaStreamResyncsTotal } from "../utils/metrics";

export class ArenaStreamController {
  constructor(private readonly arenaService: ArenaService) {}

  handleStream(req: Request, res: Response) {
    const id = req.params.id!;

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const sendEvent = (event: string, payload: unknown, sequence?: number): void => {
      if (res.writableEnded) return;
      if (sequence !== undefined) res.write(`id: ${sequence}\n`);
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const sendSnapshot = (data: unknown, sequence?: number): void => {
      if (res.writableEnded) return;
      if (sequence !== undefined) res.write(`id: ${sequence}\n`);
      res.write(`event: snapshot\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const unsubscribe = subscribeArena(
      id,
      { sendEvent, sendSnapshot },
      this.arenaService,
      (() => {
        if (req.query.resync === "1") {
          arenaStreamResyncsTotal.inc({ reason: "gap" });
          return undefined;
        }
        const raw =
          req.get("Last-Event-ID") ??
          (typeof req.query.cursor === "string" ? req.query.cursor : undefined);
        if (raw === undefined) return undefined;
        const cursor = Number(raw);
        return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : undefined;
      })(),
    );

    req.on("close", unsubscribe);
  }
}
