import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCodexAuth, parseCodexIdentity, type CodexIdentity } from "../../lib/claude-usage/codex";
import type { CodexAccountProfile } from "./collectors/codex";

/**
 * Switching seats means putting a credential where Codex actually looks.
 *
 * Codex CLI and the IDE extensions read `auth.json` out of CODEX_HOME (default
 * `~/.codex`), so "use this account" is a file swap into that one location —
 * the same mechanism cc-switch uses. There is no control channel into a running
 * Codex GUI, so a process already holding a token keeps it until it restarts;
 * this module reports that honestly rather than pretending the swap was live.
 *
 * The invariant that matters: the outgoing credential is copied into its own
 * seat directory BEFORE the incoming one lands. A seat that lived only in the
 * shared default profile would otherwise be destroyed by the first switch and
 * need a fresh browser sign-in.
 */

export type CodexSwitchOutcome =
  | { ok: true; code: "switched"; preservedTo: string | null; message: string }
  | { ok: true; code: "already_active"; message: string }
  | { ok: false; code: "needs_sign_in" | "io_error"; message: string };

export function codexAuthPath(codexHome: string): string {
  return join(codexHome, "auth.json");
}

export async function readCodexAuthFile(codexHome: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(codexAuthPath(codexHome), "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Path-independent credential identity. `codexCredentialFingerprint` folds the
 * source path in, so the same token in two profiles hashes differently — that
 * is right for noticing a rotation, wrong for "are these the same login".
 */
export function codexCredentialIdentityKey(value: unknown): string | null {
  const credential = parseCodexAuth(value);
  if (!credential) return null;
  return createHash("sha256")
    .update(credential.accountId)
    .update("\0")
    .update(credential.accessToken)
    .digest("hex")
    .slice(0, 16);
}

/** Atomic replace: a crash mid-write must never leave a truncated auth.json. */
export async function writeCodexAuthFile(codexHome: string, value: unknown): Promise<void> {
  await mkdir(codexHome, { recursive: true });
  const target = codexAuthPath(codexHome);
  const temporary = `${target}.duitsini-${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

/**
 * Where an unattributable outgoing credential is parked. Kept beside the seat
 * directories under the app's own data folder rather than loose next to
 * `~/.codex`, so a rescued file is findable and never pollutes the home folder.
 */
export function previousSignInHome(
  defaultProfile: CodexAccountProfile,
  seats: readonly CodexAccountProfile[],
): string {
  const anchor = seats[0]?.codexHome;
  return anchor
    ? join(anchor, "..", "_previous-signin")
    : join(defaultProfile.codexHome, "..", "codex-previous-signin");
}

export interface CodexSwitchOptions {
  /** The profile Codex itself reads — the shared default CODEX_HOME. */
  defaultProfile: CodexAccountProfile;
  /** The enrolled seat being switched to. */
  target: CodexAccountProfile;
  /** Every enrolled seat, used to find a home for the outgoing credential. */
  seats: readonly CodexAccountProfile[];
  /** Resolve the provider identity of the outgoing credential to a seat key. */
  ownerOf: (identity: CodexIdentity) => string | null;
}

/**
 * Point the default Codex profile at `target`, preserving whatever was there.
 *
 * Returns `already_active` without writing when the default profile already
 * holds this exact credential, so repeated clicks are harmless.
 */
export async function switchCodexAccount(options: CodexSwitchOptions): Promise<CodexSwitchOutcome> {
  const { defaultProfile, target, seats, ownerOf } = options;

  const incoming = await readCodexAuthFile(target.codexHome);
  const incomingKey = codexCredentialIdentityKey(incoming);
  if (!incomingKey) {
    return {
      ok: false,
      code: "needs_sign_in",
      message: `${target.label} has no stored sign-in yet. Use Connect account first, then switch.`,
    };
  }

  const outgoing = await readCodexAuthFile(defaultProfile.codexHome);
  const outgoingKey = codexCredentialIdentityKey(outgoing);
  if (outgoingKey && outgoingKey === incomingKey) {
    return { ok: true, code: "already_active", message: `Codex is already using ${target.label}.` };
  }

  let preservedTo: string | null = null;
  if (outgoing && outgoingKey) {
    // Already safe if some seat directory holds this same credential.
    let alreadySaved = false;
    for (const seat of seats) {
      if (codexCredentialIdentityKey(await readCodexAuthFile(seat.codexHome)) === outgoingKey) {
        alreadySaved = true;
        break;
      }
    }
    if (!alreadySaved) {
      const ownerKey = ownerOf(parseCodexIdentity(outgoing, parseCodexAuth(outgoing)));
      const owner = seats.find((seat) => seat.accountKey === ownerKey);
      // An unrecognised login still gets a home, so nothing is ever lost to a
      // switch — the user can recover it even if we cannot name its seat. It is
      // parked beside the seat directories, never loose in the home folder.
      const destination = owner
        ? { label: owner.label, codexHome: owner.codexHome }
        : { label: "a recovery folder", codexHome: previousSignInHome(defaultProfile, seats) };
      try {
        await writeCodexAuthFile(destination.codexHome, outgoing);
        preservedTo = destination.label;
      } catch (error) {
        return {
          ok: false,
          code: "io_error",
          message: `Could not preserve the current Codex sign-in, so nothing was changed: ${(error as Error).message}`,
        };
      }
    }
  }

  try {
    await writeCodexAuthFile(defaultProfile.codexHome, incoming);
  } catch (error) {
    return { ok: false, code: "io_error", message: `Could not switch Codex accounts: ${(error as Error).message}` };
  }

  return {
    ok: true,
    code: "switched",
    preservedTo,
    message: `Codex now uses ${target.label}. Restart Codex (CLI or IDE extension) to pick up the new sign-in.`,
  };
}
