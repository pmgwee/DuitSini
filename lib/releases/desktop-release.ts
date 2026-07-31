const GITHUB_REPOSITORY = "https://github.com/pmgwee/DuitSini";
const LATEST_RELEASE_URL = `${GITHUB_REPOSITORY}/releases/latest`;
const LATEST_MANIFEST_URL = `${LATEST_RELEASE_URL}/download/latest.yml`;

export interface ParsedDesktopManifest {
  version: string;
  installerName: string;
  sizeBytes: number;
}

export interface DesktopReleaseInfo {
  version: string | null;
  installerName: string | null;
  sizeBytes: number | null;
  downloadUrl: string;
  releasesUrl: string;
}

function scalar(text: string, key: string): string | null {
  const match = text.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? null;
}

/**
 * Parse the stable fields electron-builder writes into latest.yml.
 * Keeping this deliberately small avoids adding a YAML runtime just for three
 * scalar values and rejects anything that cannot form a safe installer link.
 */
export function parseDesktopUpdateManifest(text: string): ParsedDesktopManifest | null {
  const version = scalar(text, "version");
  const installerName = scalar(text, "path");
  const sizeMatch = text.match(/^\s+size:\s*(\d+)\s*$/m);
  const sizeBytes = sizeMatch ? Number(sizeMatch[1]) : Number.NaN;

  if (
    !version ||
    !installerName?.endsWith(".exe") ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0
  ) {
    return null;
  }

  return { version, installerName, sizeBytes };
}

export function releaseInfoFromManifest(
  manifest: ParsedDesktopManifest | null,
): DesktopReleaseInfo {
  return {
    version: manifest?.version ?? null,
    installerName: manifest?.installerName ?? null,
    sizeBytes: manifest?.sizeBytes ?? null,
    downloadUrl: manifest
      ? `${LATEST_RELEASE_URL}/download/${encodeURIComponent(manifest.installerName)}`
      : LATEST_RELEASE_URL,
    releasesUrl: LATEST_RELEASE_URL,
  };
}

/**
 * The updater manifest is published atomically with every desktop release.
 * Reading it without Next's data cache prevents a just-published installer from
 * being advertised under the previous version for an ISR window.
 */
export async function getLatestDesktopRelease(): Promise<DesktopReleaseInfo> {
  try {
    const response = await fetch(LATEST_MANIFEST_URL, { cache: "no-store" });
    if (!response.ok) return releaseInfoFromManifest(null);
    return releaseInfoFromManifest(parseDesktopUpdateManifest(await response.text()));
  } catch {
    return releaseInfoFromManifest(null);
  }
}

export function formatDesktopReleaseSize(bytes: number | null): string | null {
  return bytes ? `${Math.round(bytes / (1024 * 1024))} MB` : null;
}
