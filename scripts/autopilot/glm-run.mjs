#!/usr/bin/env node
/**
 * glm-run.mjs — headless GLM executor runner for the phase-autopilot skill.
 *
 * Spawns the user's GLM-backed Claude Code CLI (`claude -p`) with the GLM
 * provider env read from cc-switch (~/.cc-switch/cc-switch.db), injected
 * per-process only — the global cc-switch "current provider" is never
 * touched, so the desktop app and other terminals keep their own provider.
 *
 * The prompt travels via STDIN, never as a shell argument: Windows cmd-shell
 * argument concatenation mangles quoted prompts (verified 2026-07-11).
 *
 * Usage (always run from the project root):
 *   node scripts/autopilot/glm-run.mjs --probe
 *   node scripts/autopilot/glm-run.mjs --prompt-file <path> [--loop N]
 *       [--log <path>] [--max-turns 200] [--timeout-min 45] [--safe]
 *       [--provider <regex>]
 *
 * --loop N (default 1): after a verified successful run, re-read
 * handoff/00-MANIFEST.md; while its NEXT line still says "execute brief NN"
 * and fewer than N runs have happened, chain the next brief automatically
 * using the standard executor prompt. One orchestrator wake-up per batch
 * instead of per brief — this is what keeps top-tier desktop usage flat.
 * Any failed run, unverified model, or non-"execute brief" NEXT stops the
 * chain immediately. (--log applies to the first run only; chained runs use
 * timestamped log paths.)
 *
 * Output contract (the orchestrator parses these lines, per run):
 *   GLM_RUN exit=<n> duration_s=<n> turns=<n>
 *   MODEL_USED=<model ids>
 *   MODEL_VERIFIED=<true|false>      false => exit code 3
 *   LOG=<path>
 * and once per invocation when --loop > 1:
 *   LOOP_DONE runs=<k> next=<last NEXT line>
 *
 * Exit codes: 0 ok · 2 usage/config error · 3 model-verification failed ·
 * otherwise the claude CLI's own exit code (of the failing run).
 *
 * Secrets: the auth token is read from cc-switch and passed only via the
 * child process env; it is never printed and never written to the log.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const probe = flag("--probe");
const promptFile = opt("--prompt-file", null);
const promptInline = opt("--prompt", null);
const maxTurns = Number(opt("--max-turns", probe ? "3" : "200"));
const timeoutMs = Number(opt("--timeout-min", probe ? "5" : "45")) * 60_000;
const safe = flag("--safe");
const loopN = probe ? 1 : Math.max(1, Number(opt("--loop", "1")) || 1);
const providerRe = new RegExp(opt("--provider", "bigmodel|z\\.ai|zhipu|glm"), "i");

let initialPrompt;
if (probe) initialPrompt = "Reply with exactly one line: PROBE_OK";
else if (promptFile) initialPrompt = readFileSync(resolve(promptFile), "utf8");
else if (promptInline) initialPrompt = promptInline;
else {
  console.error("usage: glm-run.mjs --probe | --prompt-file <path> | --prompt <text>  [--loop N]");
  process.exit(2);
}

// ---- read the GLM provider env from cc-switch (read-only) ----
const DB = join(homedir(), ".cc-switch", "cc-switch.db");
if (!existsSync(DB)) {
  console.error("FATAL: " + DB + " not found — is cc-switch installed?");
  process.exit(2);
}

let rows;
try {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(DB, { readOnly: true });
  rows = db
    .prepare("select name, is_current, settings_config from providers where app_type='claude'")
    .all();
} catch {
  const r = spawnSync(
    "sqlite3",
    ["-json", DB, "select name, is_current, settings_config from providers where app_type='claude';"],
    { encoding: "utf8", shell: true, timeout: 15_000 },
  );
  if (r.status !== 0 || !r.stdout.trim()) {
    console.error("FATAL: cannot read cc-switch.db (node:sqlite and sqlite3 CLI both failed)");
    process.exit(2);
  }
  rows = JSON.parse(r.stdout);
}

const candidates = rows
  .map((r) => {
    let env = {};
    try {
      const cfg = JSON.parse(r.settings_config || "{}");
      env = cfg.env ?? {};
    } catch {}
    return { name: r.name, current: !!r.is_current, env };
  })
  .filter(
    (p) =>
      providerRe.test((p.env.ANTHROPIC_BASE_URL || "") + " " + p.name) &&
      p.env.ANTHROPIC_AUTH_TOKEN,
  );
if (!candidates.length) {
  console.error(
    "FATAL: no cc-switch provider matching /" + providerRe.source + "/i that has an auth token",
  );
  process.exit(2);
}
candidates.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0));
const provider = candidates[0];

const env = { ...process.env };
for (const [k, v] of Object.entries(provider.env)) if (typeof v === "string") env[k] = v;
delete env.CLAUDE_CODE_ENTRYPOINT; // don't look like a nested IDE session
delete env.ANTHROPIC_API_KEY; // avoid auth-source conflicts with the injected token

// ---- claude invocation (fixed literals only — safe to join) ----
const args = ["-p", "--output-format", "json", "--max-turns", String(maxTurns)];
if (!safe && !probe) args.push("--dangerously-skip-permissions");
const cmd = ["claude", ...args].join(" ");

function runOnce(prompt, runIndex) {
  const t0 = Date.now();
  const run = spawnSync(cmd, {
    shell: true,
    input: prompt,
    encoding: "utf8",
    env,
    cwd: process.cwd(),
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  let parsed = null;
  try {
    parsed = JSON.parse((run.stdout || "").trim());
  } catch {}
  const models = parsed ? Object.keys(parsed.modelUsage || {}) : [];
  const verified = models.length > 0 && models.every((m) => /glm|zhipu/i.test(m));

  // ---- log (never contains the token) ----
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultLog = join("handoff", "logs", "glm-" + ts + ".log");
  const logPath = resolve(runIndex === 1 ? opt("--log", defaultLog) : defaultLog);
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(
    logPath,
    [
      "# glm-run " + ts + " (run " + runIndex + ")",
      "provider: " + provider.name,
      "baseURL: " + (provider.env.ANTHROPIC_BASE_URL || "-") +
        " | tokenLen: " + (provider.env.ANTHROPIC_AUTH_TOKEN || "").length,
      "cmd: " + cmd,
      "exit: " + run.status + " | duration_s: " + secs +
        " | timedOut: " + (run.error && run.error.code === "ETIMEDOUT" ? "yes" : "no"),
      "models: " + (models.join(", ") || "(none)"),
      "",
      "--- PROMPT ---",
      prompt,
      "",
      "--- RESULT ---",
      parsed ? String(parsed.result ?? "") : "(stdout was not JSON)",
      "",
      "--- RAW STDOUT (tail 20k) ---",
      (run.stdout || "").slice(-20_000),
      "",
      "--- STDERR (tail 10k) ---",
      (run.stderr || "").slice(-10_000),
      "",
    ].join("\n"),
    "utf8",
  );

  // ---- summary lines the orchestrator parses ----
  console.log("GLM_RUN exit=" + run.status + " duration_s=" + secs + " turns=" + (parsed ? parsed.num_turns : "-"));
  console.log("MODEL_USED=" + (models.join(",") || "(none)"));
  console.log("MODEL_VERIFIED=" + verified);
  if (run.error) console.log("SPAWN_ERROR=" + String(run.error).slice(0, 200));
  if (parsed && typeof parsed.result === "string") {
    console.log("RESULT_TAIL:");
    console.log(parsed.result.slice(-1500));
  } else {
    console.log("STDOUT_HEAD: " + (run.stdout || "").slice(0, 500));
    console.log("STDERR_HEAD: " + (run.stderr || "").slice(0, 500));
  }
  console.log("LOG=" + logPath);

  return { status: run.status, verified };
}

function nextBriefFromManifest() {
  try {
    const txt = readFileSync(resolve("handoff/00-MANIFEST.md"), "utf8");
    const m = txt.match(/^NEXT:\s*(.+)$/m);
    if (!m) return { nn: null, nextLine: "(no NEXT line)" };
    const b = m[1].match(/execute brief\s+0*(\d+)/i);
    return { nn: b ? String(b[1]).padStart(2, "0") : null, nextLine: m[1].trim() };
  } catch {
    return { nn: null, nextLine: "(no handoff/00-MANIFEST.md)" };
  }
}

function standardPrompt(nn) {
  return [
    "Read .claude/skills/phase-autopilot/references/EXECUTOR-PROTOCOL.md and",
    "follow it exactly. Execute brief " + nn + " in handoff/ to exactly one",
    "terminal state, then stop. Do not touch any other brief.",
    "",
  ].join("\n");
}

let prompt = initialPrompt;
let runs = 0;
let last = { status: 0, verified: true };
let lastNext = "-";
while (runs < loopN) {
  last = runOnce(prompt, runs + 1);
  runs++;
  if (last.status !== 0 || !last.verified) break;
  if (runs >= loopN) {
    if (loopN > 1) lastNext = nextBriefFromManifest().nextLine;
    break;
  }
  const nb = nextBriefFromManifest();
  lastNext = nb.nextLine;
  if (!nb.nn) break; // NEXT no longer names a brief (review / re-plan / awaiting-user)
  console.log("LOOP_NEXT brief " + nb.nn);
  prompt = standardPrompt(nb.nn);
}
if (loopN > 1) console.log("LOOP_DONE runs=" + runs + " next=" + JSON.stringify(lastNext));

if (last.status !== 0) process.exit(last.status ?? 1);
if (!last.verified) process.exit(3);
