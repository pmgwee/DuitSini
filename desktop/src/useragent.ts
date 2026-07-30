import type { WebContents } from "electron";

/**
 * Make the window present as plain Chrome to Google's sign-in.
 *
 * Google refuses OAuth from anything it identifies as an embedded webview
 * ("Couldn't sign you in / This browser or app may not be secure",
 * `disallowed_useragent`). Electron IS Chromium, so this is an identity problem
 * rather than a capability one.
 *
 * The catch that makes the obvious fix fail: **setting the User-Agent string is
 * not enough.** Modern Chromium also advertises itself through User-Agent
 * Client Hints, and `webContents.setUserAgent()` does not touch them — the
 * request still carries `Sec-CH-UA: …"Electron";v="43"…` and page JS can still
 * read `navigator.userAgentData.brands` and see Electron. Google reads both.
 *
 * `Emulation.setUserAgentOverride` (Chrome DevTools Protocol) is the one call
 * that changes all three coherently: the UA string, the `Sec-CH-UA*` request
 * headers, and `navigator.userAgentData`. Overriding them separately risks
 * disagreeing with each other, which is itself a fingerprint.
 *
 * This is cosmetic identity only — no capability, sandbox, or web-security
 * setting is weakened anywhere.
 */

/** Chromium's real version, e.g. "140.0.7339.207". */
function chromeVersion(): string {
  return process.versions.chrome || "140.0.0.0";
}

function chromeMajor(): string {
  return chromeVersion().split(".")[0] || "140";
}

function platformStrings(): { ua: string; metaPlatform: string; platformVersion: string } {
  switch (process.platform) {
    case "darwin":
      return {
        ua: "Macintosh; Intel Mac OS X 10_15_7",
        metaPlatform: "macOS",
        platformVersion: "14.0.0",
      };
    case "linux":
      return { ua: "X11; Linux x86_64", metaPlatform: "Linux", platformVersion: "" };
    default:
      return {
        ua: "Windows NT 10.0; Win64; x64",
        metaPlatform: "Windows",
        platformVersion: "15.0.0",
      };
  }
}

/** A stock desktop-Chrome UA string for this Chromium build. */
export function chromeUserAgent(): string {
  return (
    `Mozilla/5.0 (${platformStrings().ua}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${chromeVersion()} Safari/537.36`
  );
}

/**
 * Apply the override to a WebContents. Safe to call more than once.
 *
 * Falls back to a plain `setUserAgent` if the debugger cannot attach (for
 * example when DevTools is already attached) — partial cover beats none, and a
 * failure here must never stop the window from loading.
 */
export function applyChromeIdentity(wc: WebContents, log: (line: string) => void): void {
  const ua = chromeUserAgent();
  const major = chromeMajor();
  const { metaPlatform, platformVersion } = platformStrings();

  wc.setUserAgent(ua);

  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
  } catch (e) {
    log(`could not attach debugger for UA override: ${(e as Error).message}`);
    return;
  }

  wc.debugger
    .sendCommand("Emulation.setUserAgentOverride", {
      userAgent: ua,
      acceptLanguage: "en-US,en",
      platform: metaPlatform,
      userAgentMetadata: {
        // Order and the "Not…A;Brand" filler mirror what stock Chrome sends;
        // a brand list that looks hand-made is its own tell.
        brands: [
          { brand: "Not;A=Brand", version: "99" },
          { brand: "Google Chrome", version: major },
          { brand: "Chromium", version: major },
        ],
        fullVersionList: [
          { brand: "Not;A=Brand", version: "99.0.0.0" },
          { brand: "Google Chrome", version: chromeVersion() },
          { brand: "Chromium", version: chromeVersion() },
        ],
        fullVersion: chromeVersion(),
        platform: metaPlatform,
        platformVersion,
        architecture: "x86",
        model: "",
        mobile: false,
      },
    })
    .catch((e: Error) => log(`UA override rejected: ${e.message}`));
}
