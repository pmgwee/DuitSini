import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless, TIME-BOUNDED deep-link code for the Telegram connect flow.
 *
 * The dashboard (session-authed) mints a code and gives the member a
 * `https://t.me/<bot>?start=<code>` link. When they open it, Telegram delivers
 * `/start <code>` to the webhook, which verifies the code and links their
 * `telegram_chat_id` — with NO new DB table or pending-link row (per plan D5).
 *
 * SECURITY POSTURE (important — do not assume single-use):
 * The code is HMAC-integrity-protected and expiry-bounded, but it is NOT
 * single-use — it is fully stateless, so it can be redeemed more than once within
 * its TTL. Residual risk: if a minted `t.me` link leaks (shared / screenshotted /
 * caught in a referrer) within the TTL, an attacker can open it from THEIR
 * Telegram and the webhook will link the victim's account to the attacker's
 * chat — redirecting the victim's reminders to the attacker (info disclosure of
 * subscription names/amounts/dates). Mitigations: only a signed-in member can
 * mint; the code is short-lived; HMAC + expiry prevent forgery and use after
 * expiry. True single-use (close the replay window entirely) needs a small
 * `telegram_link_codes` table consumed atomically on verify — an opt-in upgrade.
 *
 * Telegram constrains the `/start` payload to ≤64 chars of `[A-Za-z0-9_-]`, so
 * the code is one base64url blob (no padding) packing:
 *   userId(16 bytes) · exp(4 bytes, unix-seconds BE) · mac(16 bytes)
 * = 36 bytes → 48 base64url chars. Fits the budget with room to spare.
 *
 * The HMAC is over (userId ‖ exp) keyed by TELEGRAM_WEBHOOK_SECRET, truncated to
 * 16 bytes (128-bit). Verification recomputes it and compares with
 * `timingSafeEqual`, so a forged code reveals nothing about valid ones.
 */

// Kept short to shrink the replay window (see SECURITY POSTURE above) while
// still leaving the member ~10 min to switch to Telegram and tap Start.
const CODE_TTL_MS = 10 * 60 * 1000;

function secret(): string {
  const s = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!s) throw new Error("TELEGRAM_WEBHOOK_SECRET not configured");
  return s;
}

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error("invalid uuid");
  }
  return Buffer.from(hex, "hex");
}

function bytesToUuid(b: Buffer): string {
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function computeMac(userIdBytes: Buffer, expBytes: Buffer): Buffer {
  const h = createHmac("sha256", secret());
  h.update(Buffer.concat([userIdBytes, expBytes]));
  return h.digest().subarray(0, 16);
}

/** Build a ≤48-char Telegram `/start` code for `userId`, valid for 15 minutes. */
export function createTelegramLinkCode(userId: string, now: number = Date.now()): string {
  const userIdBytes = uuidToBytes(userId);
  const expSeconds = Math.floor((now + CODE_TTL_MS) / 1000);
  const expBytes = Buffer.alloc(4);
  expBytes.writeUInt32BE(expSeconds, 0);
  const macBytes = computeMac(userIdBytes, expBytes);
  return Buffer.concat([userIdBytes, expBytes, macBytes]).toString("base64url");
}

export type VerifyResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "malformed" | "bad signature" | "expired" };

/** Verify a `/start` code: returns the userId if the MAC matches and not expired. */
export function verifyTelegramLinkCode(code: string, now: number = Date.now()): VerifyResult {
  let buf: Buffer;
  try {
    buf = Buffer.from(code, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (buf.length !== 36) return { ok: false, reason: "malformed" };

  const userIdBytes = buf.subarray(0, 16);
  const expBytes = buf.subarray(16, 20);
  const got = buf.subarray(20, 36);
  const want = computeMac(userIdBytes, expBytes);

  // timingSafeEqual throws on length mismatch; the check above guarantees 16.
  if (!timingSafeEqual(got, want)) return { ok: false, reason: "bad signature" };

  const expiresAtMs = expBytes.readUInt32BE(0) * 1000;
  if (now > expiresAtMs) return { ok: false, reason: "expired" };

  return { ok: true, userId: bytesToUuid(userIdBytes) };
}
