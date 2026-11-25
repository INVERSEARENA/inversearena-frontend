import { isEventStreamRequest, selectEncoding } from "../../src/middleware/responseCompression";

describe("response compression (#1767)", () => {
  it("picks brotli ahead of gzip and skips an empty Accept-Encoding", () => {
    expect(selectEncoding("gzip, br")).toBe("br");
    expect(selectEncoding("gzip")).toBe("gzip");
    expect(selectEncoding(undefined)).toBeNull();
  });

  it("does not compress SSE", () => {
    expect(isEventStreamRequest({ headers: { accept: "text/event-stream" }, path: "/api/arenas/1" })).toBe(true);
    expect(isEventStreamRequest({ headers: { accept: "application/json" }, path: "/api/arenas/1/stream" })).toBe(true);
    expect(isEventStreamRequest({ headers: { accept: "application/json" }, path: "/api/arenas" })).toBe(false);
  });
});
