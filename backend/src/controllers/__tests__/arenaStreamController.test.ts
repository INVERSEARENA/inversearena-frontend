import { ArenaStreamController } from "../arenaStreamController";
import * as arenaPoller from "../../cache/arenaPoller";

describe("ArenaStreamController", () => {
  let controller: ArenaStreamController;
  let mockArenaService: any;
  let mockReq: any;
  let mockRes: any;

  beforeEach(() => {
    mockArenaService = {};
    controller = new ArenaStreamController(mockArenaService);

    mockReq = {
      params: { id: "ARENA_STREAM_1" },
      query: {},
      get: jest.fn().mockReturnValue(undefined),
      on: jest.fn(),
    };

    mockRes = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn(),
      writableEnded: false,
    };
  });

  it("sets SSE headers and subscribes to arena updates", () => {
    const unsubscribeMock = jest.fn();
    jest.spyOn(arenaPoller, "subscribeArena").mockReturnValue(unsubscribeMock);

    controller.handleStream(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream");
    expect(mockRes.setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache, no-transform");
    expect(mockRes.setHeader).toHaveBeenCalledWith("Connection", "keep-alive");
    expect(arenaPoller.subscribeArena).toHaveBeenCalledWith(
      "ARENA_STREAM_1",
      expect.any(Object),
      mockArenaService,
      undefined,
    );
    expect(mockReq.on).toHaveBeenCalledWith("close", unsubscribeMock);
  });
});
