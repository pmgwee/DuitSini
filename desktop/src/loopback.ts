/**
 * RFC 8252 §8.3 loopback redirect — the *transport* that hands the OAuth code
 * back from the system browser to this app.
 *
 * The custom-scheme (`duitsini://`) hand-off is fragile: a server-issued 302 to
 * a non-fetchable scheme is routed through the browser's external-protocol
 * dispatcher, which (on Windows Chrome) is throttled for server-redirect
 * triggers and needs a perfectly-registered, `URL Protocol`-marked handler — so
 * it can fail with no dialog and leave the browser tab spinning on Google's
 * consent-summary page forever. A loopback `http://127.0.0.1:{port}` URL is a
 * normal fetchable navigation, so it never enters that path at all. This removes
 * the entire class of failure without changing anything else.
 *
 * It is ONLY the delivery hop. The captured `?code=` is handed to the same
 * `completeSignIn` path the deep-link handler uses, which loads the web app's
 * existing `/auth/callback` route — so the PKCE exchange still happens there,
 * against the verifier cookie the web client already wrote to this window's jar.
 *
 * The allowlist entry this needs in Supabase is dashboard config, not a web-app
 * change: a glob for the loopback path with a port wildcard, plus the fixed-port
 * literal `http://127.0.0.1:43128/auth/callback` as an exact-match safety net.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { extractCallbackParams, type CallbackParams } from "./oauth";

/** Loopback only. Bind the literal IPv4 (RFC 8252); `localhost` adds DNS/IPv6 risk. */
const HOST = "127.0.0.1";
/** Unusual, stable port so the exact-match allowlist entry usually applies. */
const FIXED_PORT = Number(process.env.DUITSINI_LOOPBACK_PORT ?? 43128);

export interface LoopbackHandle {
  /** `http://127.0.0.1:<port>` — the origin `redirect_to` is rewritten to. */
  readonly origin: string;
  close(): void;
}

function page(emoji: string, title: string, body: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>DuitSini</title>" +
    "<style>" +
    ":root{color-scheme:light dark}" +
    "body{margin:0;min-height:100vh;display:grid;place-items:center;" +
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
    "background:#0b0b0f;color:#e7e7ea;text-align:center}" +
    "main{padding:2.5rem;max-width:26rem}" +
    ".mark{font-size:2.5rem;line-height:1}" +
    "h1{font-size:1.25rem;margin:1.1rem 0 .5rem;font-weight:600}" +
    "p{margin:.5rem 0;color:#a1a1aa;font-size:.95rem;line-height:1.5}" +
    "</style></head><body><main>" +
    `<div class="mark">${emoji}</div>` +
    `<h1>${title}</h1>` +
    `<p>${body}</p>` +
    "</main></body></html>"
  );
}

function send(res: ServerResponse, html: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

/**
 * Start the listener. Tries the fixed port first (exact-match allowlist), then
 * an ephemeral port (wildcard allowlist). Resolves null only if both fail,
 * which is exceedingly unlikely on a desktop — caller then falls back to the
 * `duitsini://` deep-link path.
 */
export function startLoopback(
  onCallback: (params: CallbackParams) => void,
): Promise<LoopbackHandle | null> {
  const tryListen = (port: number) =>
    new Promise<Server | null>((resolve) => {
      const server = createServer((req, res) => {
        try {
          const base = `http://${(req.headers.host ?? HOST) as string}`;
          const u = new URL(req.url ?? "/", base);
          // Only the OAuth callback path is exposed; anything else is a 404 so
          // the listener can't be abused as a generic local endpoint.
          if (!u.pathname.endsWith("/auth/callback")) {
            res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            res.end("Not found");
            return;
          }
          const params = extractCallbackParams(u);
          if (!params) {
            res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
            res.end("Missing code");
            return;
          }
          onCallback(params);
          if (params.error) {
            send(
              res,
              page(
                "⚠️",
                "Sign-in didn’t complete",
                "The browser sent back an error. Close this tab and try again from the DuitSini app.",
              ),
            );
          } else {
            send(
              res,
              page("✅", "You’re signed in", "You can close this tab and return to the DuitSini app."),
            );
          }
        } catch {
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
            res.end("error");
          }
        }
      });
      server.once("error", () => resolve(null));
      server.listen(port, HOST, () => resolve(server));
    });

  return (async () => {
    for (const port of [FIXED_PORT, 0]) {
      const server = await tryListen(port);
      if (!server) continue;
      const addr = server.address();
      const realPort = typeof addr === "object" && addr ? addr.port : port;
      return {
        origin: `http://${HOST}:${realPort}`,
        close: () => server.close(),
      };
    }
    return null;
  })();
}
