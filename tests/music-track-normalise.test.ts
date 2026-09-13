import { describe, expect, it } from "vitest";
import { toTrack } from "@/lib/music/sources";

/**
 * InnerTube hands back two incompatible shapes for a track, and only one was
 * handled.
 *
 * Radio queues populate the structured fields (`artists` / `author`). Playlist
 * items — `MusicResponsiveListItem` — leave `artists`, `author` AND `subtitle`
 * all undefined and put the artist in a POSITIONAL `flex_columns` array
 * instead. Measured live 2026-09-14 against two editorial playlists: 24/25 and
 * 25/25 rows came back with no artist, while the same normaliser produced 0/49
 * empty from a radio queue.
 *
 * The visible symptom was a missing artist line under every playlist-sourced
 * row. The quieter one: `assemble` skips its per-artist cap when the artist is
 * empty (`if (artist && ...)`), so those rows were also exempt from the
 * diversity limit that stops one artist dominating a shelf.
 *
 * Fixtures below are the real shapes, trimmed.
 */

const VIDEO_ID = "dQw4w9WgXcQ";

function flexItem(columns: string[], extra: Record<string, unknown> = {}) {
  return {
    id: VIDEO_ID,
    title: { toString: () => columns[0] },
    flex_columns: columns.map((text) => ({ title: { toString: () => text } })),
    thumbnail: [{ url: "https://example.test/a.jpg", width: 120, height: 120 }],
    ...extra,
  };
}

describe("toTrack", () => {
  it("reads the artist from flex_columns when a playlist omits the structured fields", () => {
    const track = toTrack(flexItem(["Wi$h Li$t", "Taylor Swift", "N/A"]));
    expect(track?.channel).toBe("Taylor Swift");
    expect(track?.title).toBe("Wi$h Li$t");
  });

  it("still prefers the structured artists when a radio queue supplies them", () => {
    const track = toTrack({
      video_id: VIDEO_ID,
      title: { toString: () => "BIRDS OF A FEATHER" },
      artists: [{ name: "Billie Eilish" }],
      // A flex column would disagree here; the structured field must win.
      flex_columns: [{ title: { toString: () => "BIRDS OF A FEATHER" } }, { title: { toString: () => "wrong" } }],
      thumbnail: [{ url: "https://example.test/b.jpg", width: 120, height: 120 }],
    });
    expect(track?.channel).toBe("Billie Eilish");
  });

  it("refuses the placeholder that sits where a count belongs", () => {
    // flex_columns is positional, not typed: "N/A" appears in the views slot
    // and would read as an artist name if taken at face value.
    expect(toTrack(flexItem(["Some Song", "N/A", "N/A"]))?.channel).toBe("");
  });

  it("does not repeat the title as the artist", () => {
    // Some rows duplicate the title into the second column.
    expect(toTrack(flexItem(["Same Text", "Same Text", "N/A"]))?.channel).toBe("");
  });

  it("falls back through author and authors before flex", () => {
    expect(
      toTrack(flexItem(["T", "flex-artist", "N/A"], { author: { name: "Author Name" } }))?.channel,
    ).toBe("Author Name");
    expect(
      toTrack(flexItem(["T", "flex-artist", "N/A"], { authors: [{ name: "A" }, { name: "B" }] }))
        ?.channel,
    ).toBe("A, B");
  });

  it("strips the auto-generated Topic suffix wherever the name came from", () => {
    expect(toTrack(flexItem(["Song", "Some Artist - Topic", "N/A"]))?.channel).toBe("Some Artist");
  });

  it("rejects items without a usable video id or title", () => {
    expect(toTrack(flexItem(["Song", "Artist"], { id: "not-an-id" }))).toBeNull();
    expect(toTrack({ id: VIDEO_ID, title: { toString: () => "" } })).toBeNull();
  });
});
