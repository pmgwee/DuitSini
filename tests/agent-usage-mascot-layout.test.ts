import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const trackerSource = readFileSync(
  resolve(process.cwd(), "features/dashboard/claude-usage-tracker.tsx"),
  "utf8",
);
const mascotSource = readFileSync(
  resolve(process.cwd(), "features/dashboard/agent-usage-mascot.tsx"),
  "utf8",
);

describe("agent usage mascot layout", () => {
  it("keeps quota rings in the first two slots and reserves column three for the mascot", () => {
    expect(trackerSource).toContain('className="grid grid-cols-3 gap-2"');
    expect(trackerSource).toContain('className="col-start-3 row-start-1 flex justify-center pt-3"');
    expect(trackerSource).not.toContain(
      '<UsageGauge key={l.key} limit={l} now={now} source={stream.source} />',
    );
  });

  it("repairs Claude eye transparency and keeps its black flag on a light backing in both themes", () => {
    expect(mascotSource).toContain('wrapperClass: "bg-[#fff4ef]"');
    expect(mascotSource).toContain('className="absolute left-[24%] top-[49%] z-20 h-[18%] w-[22%] bg-[#de775c] mix-blend-darken"');
    expect(mascotSource).toContain('className="absolute left-[54%] top-[49%] z-20 h-[18%] w-[22%] bg-[#de775c] mix-blend-darken"');
    expect(mascotSource).toContain('className="absolute left-[32%] top-[56%] z-30 size-[4%] bg-black"');
    expect(mascotSource).toContain('className="absolute left-[62%] top-[56%] z-30 size-[4%] bg-black"');
    expect(mascotSource).toContain("[image-rendering:pixelated]");
  });
});
