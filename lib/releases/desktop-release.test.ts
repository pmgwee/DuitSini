import { describe, expect, it } from "vitest";
import {
  formatDesktopReleaseSize,
  parseDesktopUpdateManifest,
  releaseInfoFromManifest,
} from "./desktop-release";

const MANIFEST = `version: 1.2.0
files:
  - url: DuitSini-Setup-1.2.0.exe
    sha512: ignored
    size: 99788587
path: DuitSini-Setup-1.2.0.exe
sha512: ignored
releaseDate: '2026-07-31T08:50:34.098Z'
`;

describe("desktop release metadata", () => {
  it("parses the electron-builder updater manifest", () => {
    expect(parseDesktopUpdateManifest(MANIFEST)).toEqual({
      version: "1.2.0",
      installerName: "DuitSini-Setup-1.2.0.exe",
      sizeBytes: 99_788_587,
    });
  });

  it("builds the stable latest-release installer URL", () => {
    expect(releaseInfoFromManifest(parseDesktopUpdateManifest(MANIFEST))).toMatchObject({
      version: "1.2.0",
      downloadUrl:
        "https://github.com/pmgwee/DuitSini/releases/latest/download/DuitSini-Setup-1.2.0.exe",
    });
  });

  it("rejects incomplete manifests and formats binary megabytes", () => {
    expect(parseDesktopUpdateManifest("version: 1.2.0")).toBeNull();
    expect(formatDesktopReleaseSize(99_788_587)).toBe("95 MB");
    expect(formatDesktopReleaseSize(null)).toBeNull();
  });
});
