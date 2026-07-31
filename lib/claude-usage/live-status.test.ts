import { describe, expect, it } from "vitest";
import { classifyLivePayload } from "./live-status";

describe("classifyLivePayload", () => {
  it("keeps a stale payload renderable when it has last-known streams", () => {
    expect(
      classifyLivePayload({
        error: "stale",
        streams: [{ source: "claude_pro", label: "Claude Pro", state: "offline" }],
      }),
    ).toBe("cached");
  });

  it("uses error only when there is no renderable provider reading", () => {
    expect(classifyLivePayload({ error: "stale", streams: [] })).toBe("error");
    expect(classifyLivePayload({ error: "no_data" })).toBe("error");
    expect(
      classifyLivePayload({ streams: [{ source: "codex", label: "Codex", state: "live" }] }),
    ).toBe("live");
  });
});
