import { describe, expect, it } from "vitest";
import {
  MIN_429_BACKOFF_MS,
  USAGE_429_QUIET_MS,
  REFRESH_COOLDOWNS_MS,
  REAUTH_BLOCK_MS,
  TOKEN_5XX_BLOCK_MS,
  CODEX_USAGE_429_QUIET_MS,
  proUsage429Hold,
  codexUsage429Hold,
  glmRetryHold,
  glmBackoffHold,
  refresh429Hold,
  reauthHold,
  token5xxHold,
} from "./backoff";

describe("codexUsage429Hold", () => {
  it("uses a conservative [5,15,30,60] minute ladder", () => {
    expect([...CODEX_USAGE_429_QUIET_MS]).toEqual([300_000, 900_000, 1_800_000, 3_600_000]);
    expect(codexUsage429Hold(1, undefined, 0)).toBe(300_000);
    expect(codexUsage429Hold(2, undefined, 0)).toBe(900_000);
    expect(codexUsage429Hold(3, undefined, 0)).toBe(1_800_000);
    expect(codexUsage429Hold(4, undefined, 0)).toBe(3_600_000);
    expect(codexUsage429Hold(20, undefined, 0)).toBe(3_600_000);
  });

  it("honors a longer retry-after and adds injected jitter", () => {
    expect(codexUsage429Hold(1, 1_200_000, 0)).toBe(1_200_000);
    expect(codexUsage429Hold(1, undefined, 15_000)).toBe(315_000);
  });
});

describe("v7 backoff constants (verbatim)", () => {
  it("pins the usage-429 quiet ladder [15,30,60]min (pro source)", () => {
    expect([...USAGE_429_QUIET_MS]).toEqual([900_000, 1_800_000, 3_600_000]);
  });
  it("pins the refresh-429 ladder [15,30,60,120]min", () => {
    expect([...REFRESH_COOLDOWNS_MS]).toEqual([900_000, 1_800_000, 3_600_000, 7_200_000]);
  });
  it("pins the floor and the reauth / 5xx block durations", () => {
    expect(MIN_429_BACKOFF_MS).toBe(60_000);
    expect(REAUTH_BLOCK_MS).toBe(3_600_000);
    expect(TOKEN_5XX_BLOCK_MS).toBe(600_000);
  });
});

describe("proUsage429Hold — usage-429 quiet (pro source only)", () => {
  it("escalates through the ladder with streak (jitter=0)", () => {
    expect(proUsage429Hold(1, undefined, 0)).toBe(900_000);
    expect(proUsage429Hold(2, undefined, 0)).toBe(1_800_000);
    expect(proUsage429Hold(3, undefined, 0)).toBe(3_600_000);
  });
  it("clamps streak beyond the ladder to the last rung (60m)", () => {
    expect(proUsage429Hold(10, undefined, 0)).toBe(3_600_000);
  });
  it("lets the server retry-after win when it is longer than the ladder", () => {
    expect(proUsage429Hold(1, 2_000_000, 0)).toBe(2_000_000);
  });
  it("adds the injected jitter on top of the hold", () => {
    expect(proUsage429Hold(1, undefined, 25_000)).toBe(925_000);
  });
});

describe("glmRetryHold — GLM 429 with a usable retry-after", () => {
  it("floors at MIN_429_BACKOFF_MS when retry-after is tiny", () => {
    expect(glmRetryHold(0, 0)).toBe(60_000);
  });
  it("adds the +3s and the jitter inside the floor/cap", () => {
    expect(glmRetryHold(100_000, 0)).toBe(103_000);
    expect(glmRetryHold(100_000, 4_000)).toBe(107_000);
  });
  it("caps at 600s", () => {
    expect(glmRetryHold(10_000_000, 0)).toBe(600_000);
  });
});

describe("glmBackoffHold — GLM 429 exponential (no retry-after)", () => {
  it("doubles the previous backoff (or PUSH_MS) and floors at 60s", () => {
    expect(glmBackoffHold(undefined, 10_000)).toBe(60_000); // 2*10000=20000 -> floored
    expect(glmBackoffHold(60_000, 300_000)).toBe(120_000); // 2*60000
  });
  it("caps at 300s", () => {
    expect(glmBackoffHold(undefined, 300_000)).toBe(300_000); // 2*300000 -> capped
  });
});

describe("refresh429Hold — refresh-endpoint 429 ladder", () => {
  it("escalates through [15,30,60,120]min (jitter=0)", () => {
    expect(refresh429Hold(1, undefined, 0)).toBe(900_000);
    expect(refresh429Hold(2, undefined, 0)).toBe(1_800_000);
    expect(refresh429Hold(3, undefined, 0)).toBe(3_600_000);
    expect(refresh429Hold(4, undefined, 0)).toBe(7_200_000);
  });
  it("clamps streak beyond the ladder to the last rung (120m)", () => {
    expect(refresh429Hold(10, undefined, 0)).toBe(7_200_000);
  });
  it("lets the server retry-after win and adds the jitter", () => {
    expect(refresh429Hold(1, 5_000_000, 0)).toBe(5_000_000);
    expect(refresh429Hold(1, undefined, 100_000)).toBe(1_000_000);
  });
});

describe("reauth / 5xx holds", () => {
  it("reauth holds 60min (only a re-login clears it)", () => {
    expect(reauthHold()).toBe(3_600_000);
  });
  it("token 5xx holds 10min", () => {
    expect(token5xxHold()).toBe(600_000);
  });
});
