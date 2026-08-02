"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Heart,
  History,
  ListMusic,
  Music4,
  Pause,
  Play,
  Search,
  Undo2,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { MusicPlaylist, MusicTrack } from "@/types/music";
import { useMusicPlayer } from "./player-context";

type Shelf = "listen" | "playlists" | "liked" | "search";

const SHELVES: Array<{ id: Shelf; label: string; icon: typeof History }> = [
  { id: "listen", label: "Listen again", icon: History },
  { id: "playlists", label: "Playlists", icon: ListMusic },
  { id: "liked", label: "Liked", icon: Heart },
  { id: "search", label: "Search", icon: Search },
];

interface LibraryResponse {
  connected: boolean;
  playlists: MusicPlaylist[];
}
interface ListenAgainResponse {
  tracks: MusicTrack[];
  seeded: boolean;
}
interface LikesResponse {
  tracks: MusicTrack[];
}

/**
 * A transient confirmation with an escape hatch.
 *
 * Every like, unlike and suppression raises one. This is the fix for the single
 * most-reported flaw in Spotify's own liked list: a heart rendered on every row
 * means people un-like tracks by accident while scrolling, and with no undo the
 * track is effectively gone. Making the action reversible costs one state
 * variable and removes the entire class of complaint.
 */
interface ToastState {
  message: string;
  /** Primary escape hatch — always present. */
  undo: () => void;
  /** Optional softer alternative (e.g. "Snooze instead" after a hard block). */
  alt?: { label: string; run: () => void };
}

async function getJSON<T>(url: string, fallback: T): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) return fallback;
  return (await r.json()) as T;
}

// useLayoutEffect on the client, useEffect during SSR (so the server renderer
// doesn't warn). Registers/clears the dock slot for the persistent video portal.
const useDockLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Minimalist YouTube Music library on the dashboard. The live IFrame player is
 * owned by the persistent MusicPlayerProvider and lives in a fixed portal that
 * is never reparented. Here we **register** an empty slot in the Music card;
 * the provider glues the video over that slot's rect so it looks docked inline
 * (exactly like before cross-page support). Leaving /dashboard unmounts this
 * component, which clears the slot — the video parks off-screen and keeps
 * playing, surfaced instead by the floating mini-bar.
 */
export function MusicWidget() {
  const [shelf, setShelf] = useState<Shelf>("listen");
  const [openPlaylist, setOpenPlaylist] = useState<MusicPlaylist | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MusicTrack[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchConfigured, setSearchConfigured] = useState<boolean | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);

  const player = useMusicPlayer();
  const queryClient = useQueryClient();

  // Auto-dismiss. 6s is long enough to read and reach the undo, short enough
  // that it never feels like it's in the way.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(id);
  }, [toast]);

  // Register the inline slot so the fixed video portal glues itself over it.
  // The layout effect's cleanup runs before the slot detaches on unmount, so
  // the portal parks off-screen cleanly (the iframe is never touched/reloaded).
  const slotRef = useRef<HTMLDivElement>(null);
  useDockLayoutEffect(() => {
    player.registerSlot(slotRef.current);
    return () => player.registerSlot(null);
  }, [player]);

  const library = useQuery({
    queryKey: ["yt", "library"],
    queryFn: () =>
      getJSON<LibraryResponse>("/api/yt/library", { connected: false, playlists: [] }),
    staleTime: 5 * 60_000,
  });
  const connected = library.data?.connected ?? false;

  const listenAgain = useQuery({
    queryKey: ["yt", "listen-again"],
    queryFn: () =>
      getJSON<ListenAgainResponse>("/api/yt/plays", { tracks: [], seeded: false }),
    staleTime: 60_000,
  });

  // Local likes — the taste signal we own. Distinct from the imported YouTube
  // "Liked Music" list below, which is read-only and only a cold-start prior.
  const likes = useQuery({
    queryKey: ["yt", "likes"],
    queryFn: () => getJSON<LikesResponse>("/api/yt/likes", { tracks: [] }),
    staleTime: 30_000,
  });
  const likedIds = new Set((likes.data?.tracks ?? []).map((t) => t.videoId));

  /** Refetch everything a taste signal can move. */
  const invalidateTaste = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["yt", "likes"] });
    void queryClient.invalidateQueries({ queryKey: ["yt", "listen-again"] });
  }, [queryClient]);

  const likeTrack = useCallback(
    async (track: MusicTrack) => {
      await fetch("/api/yt/likes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoId: track.videoId,
          title: track.title,
          channel: track.channel,
          thumbnail: track.thumbnail,
        }),
      }).catch(() => {});
      invalidateTaste();
    },
    [invalidateTaste],
  );

  const unlikeTrack = useCallback(
    async (videoId: string) => {
      await fetch("/api/yt/likes", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId }),
      }).catch(() => {});
      invalidateTaste();
    },
    [invalidateTaste],
  );

  const toggleLike = useCallback(
    async (track: MusicTrack) => {
      const wasLiked = likedIds.has(track.videoId);
      if (wasLiked) {
        await unlikeTrack(track.videoId);
        setToast({
          message: `Removed “${track.title}” from Liked`,
          undo: () => void likeTrack(track),
        });
      } else {
        await likeTrack(track);
        setToast({
          message: `Added “${track.title}” to Liked`,
          undo: () => void unlikeTrack(track.videoId),
        });
      }
    },
    [likedIds, likeTrack, unlikeTrack],
  );

  /** Push a track away. Hard block by default, with snooze offered as the softer option. */
  const suppressTrack = useCallback(
    async (track: MusicTrack) => {
      const send = (kind: "not_interested" | "snooze") =>
        fetch("/api/yt/suppress", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoId: track.videoId, kind }),
        })
          .catch(() => {})
          .then(invalidateTaste);

      await send("not_interested");
      setToast({
        message: `Won’t suggest “${track.title}” again`,
        undo: () => {
          void fetch("/api/yt/suppress", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videoId: track.videoId }),
          })
            .catch(() => {})
            .then(invalidateTaste);
        },
        alt: { label: "Snooze 30d instead", run: () => void send("snooze") },
      });
    },
    [invalidateTaste],
  );

  const playlistId = shelf === "liked" ? "LM" : openPlaylist?.id ?? null;
  const playlistTracks = useQuery({
    queryKey: ["yt", "playlist", playlistId],
    queryFn: () =>
      getJSON<{ tracks: MusicTrack[] }>(
        `/api/yt/playlist?id=${encodeURIComponent(playlistId!)}`,
        { tracks: [] },
      ),
    enabled: Boolean(playlistId) && connected,
    staleTime: 5 * 60_000,
  });

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    try {
      const r = await fetch(`/api/yt/search?q=${encodeURIComponent(q)}`);
      const json = (await r.json()) as { results?: MusicTrack[]; configured?: boolean };
      setSearchConfigured(json.configured ?? false);
      setSearchResults(json.results ?? []);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const pct = player.duration > 0 ? Math.min(100, (player.position / player.duration) * 100) : 0;
  const VolIcon = player.muted || player.volume === 0 ? VolumeX : player.volume >= 50 ? Volume2 : Volume1;

  const connectHint = (
    <div className="rounded-xl border border-border/60 bg-surface-2/40 px-3 py-3 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">Sync your YouTube Music.</span> Sign out, then
      sign back in with Google — the app will ask for read access to your playlists &amp; likes.
    </div>
  );

  return (
    <div className="flex h-full flex-col gap-4 rounded-2xl border border-border/60 bg-surface/40 p-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Music4 className="size-4 text-primary" /> Music
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
            connected
              ? "bg-success/10 text-success ring-1 ring-success/25"
              : "bg-muted/60 text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              connected ? "bg-success" : "bg-muted-foreground/60",
            )}
          />
          {connected ? "Synced with YouTube" : "Not synced"}
        </span>
      </div>

      {/* Player surface (kept visible & unobstructed per YouTube ToS). This is
          an empty slot that reserves the video's space; the persistent provider
          glues the live IFrame over it (rect-tracked) so it looks docked inline.
          The placeholder shows until a track is playing. */}
      <div className="relative overflow-hidden rounded-xl bg-black/60">
        <div className="aspect-video w-full">
          <div ref={slotRef} className="h-full w-full" />
        </div>
        {!player.current && (
          <div className="absolute inset-0 grid place-items-center bg-gradient-to-br from-surface-2/80 to-background">
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Music4 className="size-8 opacity-60" />
              <span className="text-xs">Pick a track to start listening</span>
            </div>
          </div>
        )}
      </div>

      {/* Now playing + controls */}
      <div>
        <div className="min-h-[2.5rem]">
          {player.current ? (
            <>
              <div className="truncate text-sm font-medium">{player.current.title}</div>
              <div className="truncate text-xs text-muted-foreground">
                {player.current.channel}
              </div>
            </>
          ) : (
            <div className="text-xs text-muted-foreground">
              Your playlists &amp; likes, synced from your Google account.
            </div>
          )}
        </div>

        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-[11px] tabular-nums text-muted-foreground">
          <span>{formatTime(player.position)}</span>
          <span>{formatTime(player.duration)}</span>
        </div>

        <div className="mt-2 flex items-center gap-3">
          {/* Balance spacer keeps the transport centered; the volume control
              sits at the right edge, mirroring the floating mini-player so the
              two stay visually consistent across pages. */}
          <div className="flex-1" aria-hidden="true" />
          <button
            type="button"
            aria-label="Previous"
            onClick={player.prev}
            disabled={!player.hasPrev}
            className="grid size-10 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <ChevronLeft className="size-5" />
          </button>
          <button
            type="button"
            aria-label={player.isPlaying ? "Pause" : "Play"}
            onClick={player.toggle}
            className={cn(
              "grid size-12 place-items-center rounded-full bg-primary text-primary-foreground card-elevated transition-transform hover:brightness-110 active:scale-95",
              !player.current && "opacity-50",
            )}
          >
            {player.isPlaying ? (
              <Pause className="size-5" />
            ) : (
              <Play className="size-5 translate-x-0.5" />
            )}
          </button>
          <button
            type="button"
            aria-label="Next"
            onClick={player.next}
            disabled={!player.hasNext}
            className="grid size-10 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <ChevronRight className="size-5" />
          </button>
          <div className="flex flex-1 items-center justify-end gap-1">
            <button
              type="button"
              aria-label={player.muted ? "Unmute" : "Mute"}
              onClick={player.toggleMute}
              className="grid size-9 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <VolIcon className="size-4" />
            </button>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              aria-label="Volume"
              value={player.muted ? 0 : player.volume}
              onChange={(e) => player.setVolume(Number(e.target.value))}
              className="vol-slider h-1 w-20 cursor-pointer accent-primary sm:w-24"
            />
          </div>
        </div>
      </div>

      {/* Shelf tabs */}
      <div className="flex gap-1 rounded-xl bg-surface-2/60 p-1">
        {SHELVES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setShelf(id);
              if (id !== "playlists") setOpenPlaylist(null);
            }}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors",
              shelf === id
                ? "bg-surface text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      {/* Shelf content — grows to fill the card so the list reaches the bottom
          edge (aligned like the Connect Claude card in the left column). */}
      <div className="flex min-h-[9rem] flex-1 flex-col">
        {shelf === "listen" &&
          (connected ? (
            <div className="flex flex-1 flex-col gap-2">
              {listenAgain.isLoading ? (
                <ShelfNote>Loading your listens…</ShelfNote>
              ) : (listenAgain.data?.tracks.length ?? 0) > 0 ? (
                <>
                  {listenAgain.data?.seeded && (
                    <p className="mb-1.5 text-[11px] text-muted-foreground/80">
                      Seeded from your Liked Music — plays in this app take over from here.
                    </p>
                  )}
                  <TrackList
                    tracks={listenAgain.data!.tracks}
                    activeId={player.current?.videoId}
                    onPlay={(i) => void player.playQueue(listenAgain.data!.tracks, i)}
                    likedIds={likedIds}
                    onToggleLike={(t) => void toggleLike(t)}
                    onSuppress={(t) => void suppressTrack(t)}
                  />
                </>
              ) : (
                <ShelfNote>Play something — this shelf builds itself from your listens.</ShelfNote>
              )}
            </div>
          ) : (
            connectHint
          ))}

        {shelf === "playlists" &&
          (!connected ? (
            connectHint
          ) : openPlaylist ? (
            <>
              <button
                type="button"
                onClick={() => setOpenPlaylist(null)}
                className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
              >
                <ChevronLeft className="size-3.5" /> {openPlaylist.title}
              </button>
              {playlistTracks.isLoading ? (
                <ShelfNote>Loading tracks…</ShelfNote>
              ) : (
                <TrackList
                  tracks={playlistTracks.data?.tracks ?? []}
                  activeId={player.current?.videoId}
                  onPlay={(i) => void player.playQueue(playlistTracks.data?.tracks ?? [], i)}
                />
              )}
            </>
          ) : library.isLoading ? (
            <ShelfNote>Loading playlists…</ShelfNote>
          ) : (
            <ul className="flex max-h-83 min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
              {library.data?.playlists.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setOpenPlaylist(p)}
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent"
                  >
                    {p.thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.thumbnail} alt="" className="size-10 shrink-0 rounded object-cover" />
                    ) : (
                      <div className="grid size-10 shrink-0 place-items-center rounded bg-muted text-muted-foreground">
                        {p.id === "LM" ? <Heart className="size-4" /> : <ListMusic className="size-4" />}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">{p.title}</div>
                      {p.itemCount > 0 && (
                        <div className="text-[11px] text-muted-foreground">
                          {p.itemCount} tracks
                        </div>
                      )}
                    </div>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          ))}

        {/* Liked = the tracks YOU hearted here. This is the store shelf for the
            signal we actually own and learn from. The imported YouTube "Liked
            Music" list is shown underneath, clearly separated, because it is
            read-only and only seeds recommendations while this shelf is empty. */}
        {shelf === "liked" &&
          (likes.isLoading ? (
            <ShelfNote>Loading your likes…</ShelfNote>
          ) : (likes.data?.tracks.length ?? 0) > 0 ? (
            <TrackList
              tracks={likes.data!.tracks}
              activeId={player.current?.videoId}
              onPlay={(i) => void player.playQueue(likes.data!.tracks, i)}
              likedIds={likedIds}
              onToggleLike={(t) => void toggleLike(t)}
              // No "not interested" here — pushing away something you just
              // hearted is contradictory; unliking is the right verb.
            />
          ) : (
            <div className="flex flex-1 flex-col gap-2">
              <ShelfNote>
                Tap the ♥ on any track to save it here — it teaches your
                recommendations too.
              </ShelfNote>
              {connected && (playlistTracks.data?.tracks.length ?? 0) > 0 && (
                <>
                  <p className="px-1 text-[11px] text-muted-foreground/80">
                    From your YouTube Music likes
                  </p>
                  <TrackList
                    tracks={playlistTracks.data!.tracks}
                    activeId={player.current?.videoId}
                    onPlay={(i) => void player.playQueue(playlistTracks.data!.tracks, i)}
                    likedIds={likedIds}
                    onToggleLike={(t) => void toggleLike(t)}
                  />
                </>
              )}
            </div>
          ))}

        {shelf === "search" && (
          <div className="flex flex-col gap-2">
            {searchConfigured === false && (
              <div className="rounded-xl border border-warning/30 bg-warning/6 px-3 py-2 text-xs text-warning">
                Set <code className="font-mono">YOUTUBE_API_KEY</code> (server env) to enable
                search.
              </div>
            )}
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  aria-label="Search music"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && search()}
                  placeholder="Search a song or artist…"
                  className="h-10 w-full rounded-xl border border-border/60 bg-input/50 pl-9 pr-3 text-sm outline-none focus:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/40"
                />
              </div>
              <button
                type="button"
                onClick={search}
                disabled={searching}
                className="rounded-xl border border-border/60 bg-surface-2 px-3 text-sm font-medium hover:bg-accent disabled:opacity-50"
              >
                {searching ? "…" : "Search"}
              </button>
            </div>
            {searchResults.length > 0 && (
              <TrackList
                tracks={searchResults}
                activeId={player.current?.videoId}
                onPlay={(i) => void player.playQueue(searchResults, i)}
                likedIds={likedIds}
                onToggleLike={(t) => void toggleLike(t)}
              />
            )}
          </div>
        )}
      </div>

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-xl border border-border/60 bg-surface-2 px-3 py-2 text-xs shadow-lg"
        >
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{toast.message}</span>
          {toast.alt && (
            <button
              type="button"
              onClick={() => {
                toast.alt!.run();
                setToast(null);
              }}
              className="shrink-0 rounded-lg px-2 py-1 font-medium text-muted-foreground hover:bg-accent"
            >
              {toast.alt.label}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              toast.undo();
              setToast(null);
            }}
            className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 font-semibold text-primary hover:bg-accent"
          >
            <Undo2 className="size-3.5" />
            Undo
          </button>
        </div>
      )}

      <p className="text-center text-[11px] text-muted-foreground/70">
        Powered by YouTube · official Data &amp; IFrame APIs · keeps playing across pages
      </p>
    </div>
  );
}

function ShelfNote({ children }: { children: React.ReactNode }) {
  return <p className="px-1 py-4 text-center text-xs text-muted-foreground">{children}</p>;
}

function TrackList({
  tracks,
  activeId,
  onPlay,
  likedIds,
  onToggleLike,
  onSuppress,
}: {
  tracks: MusicTrack[];
  activeId?: string;
  onPlay: (index: number) => void;
  /** videoIds the listener has liked — drives the filled heart. */
  likedIds?: Set<string>;
  onToggleLike?: (track: MusicTrack) => void;
  /** Omitted on shelves where "not interested" is meaningless (e.g. Liked). */
  onSuppress?: (track: MusicTrack) => void;
}) {
  return (
    // Shared by every shelf so the cap is identical across all of them. Rows
    // are compact (py-1 + 40px thumb ≈ 48px) so 6 rows + gaps (~308px) sit
    // comfortably under the max-h-83 cap with buffer — the 6th row is never
    // clipped, even in the Playlists shelf where the back-button trims the
    // list's available height. Anything beyond 6 scrolls into view.
    <ul className="flex max-h-83 min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
      {tracks.map((t, i) => {
        const liked = likedIds?.has(t.videoId) ?? false;
        return (
          // The row is a flex container rather than one big button: a nested
          // button is invalid HTML, and the like control must be its own hit
          // target so it can never be triggered by a mis-aimed play tap.
          <li
            key={`${t.videoId}-${i}`}
            className={cn(
              "group flex items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-accent",
              t.videoId === activeId && "bg-accent",
            )}
          >
            <button
              type="button"
              onClick={() => onPlay(i)}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1.5 text-left"
            >
              {t.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={t.thumbnail} alt="" className="size-10 shrink-0 rounded object-cover" />
              ) : (
                <div className="grid size-10 shrink-0 place-items-center rounded bg-muted text-muted-foreground">
                  <Music4 className="size-4" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium">{t.title}</span>
                  {t.source === "recommended" && (
                    <span className="shrink-0 rounded-full bg-primary/12 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-primary ring-1 ring-primary/20">
                      For you
                    </span>
                  )}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">{t.channel}</div>
              </div>
            </button>

            {/* One button, one job — this ONLY likes. Spotify's equivalent also
                opens a playlist picker depending on state, which is their
                most-complained-about interaction. */}
            {onToggleLike && (
              <button
                type="button"
                onClick={() => onToggleLike(t)}
                aria-pressed={liked}
                aria-label={liked ? `Remove ${t.title} from Liked` : `Like ${t.title}`}
                title={liked ? "Remove from Liked" : "Like"}
                className={cn(
                  "grid size-8 shrink-0 place-items-center rounded-full transition-colors hover:bg-background/70",
                  // A set like stays visible; an unset one appears on hover or
                  // keyboard focus, so resting rows stay quiet.
                  liked
                    ? "text-primary"
                    : "text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
                )}
              >
                <Heart className={cn("size-4", liked && "fill-current")} />
              </button>
            )}

            {onSuppress && (
              <button
                type="button"
                onClick={() => onSuppress(t)}
                aria-label={`Don't suggest ${t.title} again`}
                title="Not interested"
                className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground opacity-0 transition-colors hover:bg-background/70 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
              >
                <X className="size-4" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function formatTime(sec: number): string {
  if (!sec || !isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
