# macOS Claude Usage Sharer — Investigation Brief (for a MacBook + AI agent)

**You are:** a teammate on macOS who wants your **Claude Pro usage** to appear live on a class
dashboard. A small Node script ("the sharer") reads your Claude credentials **from your own
machine** and pushes only the usage **percentages** (e.g. `53%`) to the dashboard. It never sends
your password or token.

**The problem we need you to solve:** the sharer only knows how to read credentials from a **JSON
file**. On Windows/Linux that file exists. **On macOS, Claude Code stores credentials in the
Keychain, not a file** — so the sharer reports `No usage sent. No Claude Pro sign-in found`, even
after a normal, correct `claude` login. We confirmed on the target Mac that
`~/.claude-pro/.credentials.json` does **not** exist even after `CLAUDE_CONFIG_DIR=~/.claude-pro claude`.

Your job: **hand this file to an AI coding agent on the MacBook** (Claude Code, Cursor, etc.), have
it investigate and **test** a working, safe approach, and **fill in the "Output to send back"
section** at the bottom. Send that completed section back to the dashboard owner so they can update
the sharer for macOS.

---

## 🔒 HARD RUBRIC — non-negotiable requirements (read first)

The single most important property: **ZERO risk to your future official Claude Code login.** Any
proposed solution that fails **even one** of these is rejected — do not implement or recommend it.

The AI agent MUST NOT propose or perform anything that:

1. ❌ **Writes to, modifies, rotates, or deletes the macOS Keychain entry** `Claude Code-credentials`.
   That entry is your live, everyday Claude Code login. Reading it is discussed below; **writing it is
   forbidden.**
2. ❌ **Sets `CLAUDE_CODE_OAUTH_TOKEN` and then runs `claude`.** There is a documented bug where this
   **silently deletes your Keychain credentials on exit**
   (github.com/anthropics/claude-code/issues/37512). Never combine that env var with launching `claude`.
3. ❌ **Creates a shared-refresh-token situation** — i.e. the sharer and your official CLI both
   refreshing the *same* rotating token. Rotation would eventually bump your official login and force a
   re-login. The sharer's credential lifecycle must be **independent** of your everyday login.
4. ❌ **Persists environment variables** to `~/.zshrc`, `~/.bash_profile`, `~/.zprofile`, etc. in a way
   that redirects or changes **future** `claude` invocations.
5. ❌ **Requires `claude logout`, `/logout`, or anything that invalidates the current session.**
6. ❌ **Sends the actual access token, refresh token, or any credential off the machine** — to the
   dashboard, to this document, to chat, anywhere. Only **percentages** and **redacted** diagnostics
   may leave the machine. (Report shapes/prefixes like `sk-ant-oat01-…`, never full values.)

**Acceptance test for any candidate solution:** *"After the sharer has been running and self-refreshing
for 24h, can I open Terminal, run plain `claude`, and use Claude Code exactly as before — no re-login,
no errors, no missing Keychain entry?"* If you cannot answer an unqualified **yes**, the candidate fails.

---

## How the sharer works (facts the agent needs)

- **Credential shape it expects** (JSON): an object containing
  `{"claudeAiOauth": {"accessToken": "...", "refreshToken": "...", "expiresAt": <ms> }}`.
- **Where it looks (files only, in order):** `$CLAUDE_SUB_CONFIG_DIR/.credentials.json`,
  `~/.claude-pro/.credentials.json`, `~/.claude-sub/.credentials.json`,
  `$CLAUDE_CONFIG_DIR/.credentials.json`, `~/.claude/.credentials.json`. First one with a usable
  `accessToken` + `refreshToken` wins.
- **How it reads usage** — a plain HTTPS GET, no SDK:
  ```
  GET https://api.anthropic.com/api/oauth/usage
  Authorization: Bearer <accessToken>
  anthropic-beta: oauth-2025-04-20
  User-Agent: claude-code/2.1.0
  Content-Type: application/json
  ```
  A working response contains `five_hour`, `seven_day`, and a `limits[]` array (utilization %).
- **How it refreshes** (when the access token nears expiry): POST to
  `https://platform.claude.com/v1/oauth/token` (fallback `https://console.anthropic.com/v1/oauth/token`)
  with `{grant_type:"refresh_token", refresh_token, client_id:"9d1c250a-e61b-44d9-88ed-5944d1962f5e"}`.
  **This rotates the refresh token** — which is exactly why rubric #3 matters.

---

## The leading hypothesis to TEST (Option A — most likely the zero-risk answer)

Anthropic ships an official mechanism for exactly this situation ("scripts where browser login isn't
available"): **`claude setup-token`**. It generates a **separate, long-lived (~1 year) OAuth token**,
**saves it nowhere**, and (per the docs) does **not** touch your Keychain login. That independence is
what makes it a rubric-compliant candidate.

**The open question the agent must answer with a real test:** *does a `setup-token`-generated token
actually return data from `GET /api/oauth/usage`?* (The token is "scoped to inference" per the docs —
so this is genuinely unverified for the usage endpoint. Test it; don't assume.)

### Exact test procedure

```bash
# 1) Generate an independent token. This does NOT modify your Keychain login.
#    It prints a token starting with sk-ant-oat01-...  Copy it.
claude setup-token

# 2) Put it in a shell variable (this session only — do NOT export to rc files,
#    and do NOT run `claude` while this is set, per rubric #2).
TOKEN='sk-ant-oat01-...paste-here...'

# 3) Ask the usage endpoint directly, exactly as the sharer would:
curl -s \
  -H "Authorization: Bearer $TOKEN" \
  -H "anthropic-beta: oauth-2025-04-20" \
  -H "User-Agent: claude-code/2.1.0" \
  -H "Content-Type: application/json" \
  https://api.anthropic.com/api/oauth/usage | head -c 800; echo

# 4) Confirm your everyday login is untouched (should print account/plan, no re-login):
claude --version
```

**Interpret:**
- If step 3 returns JSON with `five_hour` / `seven_day` / `limits` → **Option A works.** The dashboard
  owner will add a `CLAUDE_CODE_OAUTH_TOKEN` (or a pasted-token) path to the sharer. Best outcome:
  independent credential, zero Keychain interaction, passes the whole rubric.
- If step 3 returns `401`/`403`/an error → Option A is out for usage; note the exact status + body
  (redacted) and move to the fallback question below.

## Fallback question (only if Option A fails) — Option B, read-only Keychain

macOS can *read* the Keychain entry without modifying it:
```bash
# READ-ONLY. Does not change anything. macOS may show a one-time "allow" prompt.
security find-generic-password -a "$USER" -s "Claude Code-credentials" -w | head -c 60; echo
```
This returns the same JSON shape the sharer wants. **But** a read-only copy still expires (~1h), and
refreshing it would rotate the shared refresh token → **violates rubric #3**. So Option B is only
acceptable if the agent can design a variant that **never rotates the shared token** (e.g. read-only,
short-lived, re-reading Keychain each cycle instead of refreshing). The agent should state plainly
whether a rubric-compliant Option B is even possible, or whether Option A is the only safe path.

---

## 🔗 GitHub / official references

- **Credential storage (macOS = Keychain; `CLAUDE_CONFIG_DIR` file redirect is Linux/Windows only):**
  https://code.claude.com/docs/en/iam
- **`claude setup-token` (long-lived independent token):** same page, "Generate a long-lived token".
- **Bug — `CLAUDE_CODE_OAUTH_TOKEN` silently deletes Keychain creds on exit (rubric #2):**
  https://github.com/anthropics/claude-code/issues/37512
- **Bug — OAuth creds shared across `CLAUDE_CONFIG_DIR` profiles on macOS (why the folder trick fails):**
  https://github.com/anthropics/claude-code/issues/20553
- **Keychain service name / format reference:**
  https://github.com/anthropics/claude-code/issues/9403

---

## 📋 THE PROMPT — paste this to the AI agent on the MacBook

> You are helping me make a Node "usage sharer" script work on macOS. Read the file
> `macos-sharer-investigation.md` in full before doing anything. Your objective: determine and **test**
> a way for the sharer to obtain my **Claude Pro** access token on macOS so it can call
> `GET https://api.anthropic.com/api/oauth/usage`, **without any risk to my everyday Claude Code login.**
>
> **Treat the "HARD RUBRIC" section as absolute constraints.** Before proposing or running anything,
> check it against all 6 forbidden items and the acceptance test. If a step could touch, rotate, or
> delete my Keychain `Claude Code-credentials` entry, or change future `claude` behavior, **do not do
> it** — explain why and pick a safer path.
>
> Do this:
> 1. Report my environment: `node --version`, `claude --version`, macOS version, and confirm creds are
>    in Keychain not a file (`ls -la ~/.claude/.credentials.json` and `~/.claude-pro/.credentials.json`).
> 2. Run the **Option A** test procedure exactly as written (setup-token → curl the usage endpoint).
>    Report the HTTP status and the **redacted** response shape (field names only, never token/values).
> 3. If Option A fails, evaluate whether a **rubric-compliant Option B** (read-only, non-rotating) is
>    even possible, and say so honestly.
> 4. Confirm the acceptance test: after your steps, `claude` still works with no re-login.
> 5. **Write your findings to a NEW standalone file** named `macos-sharer-findings.md` in the current
>    directory, using the "OUTPUT" template at the bottom of this brief as its exact structure. This is
>    the single file I send back to the dashboard owner — it must be self-contained and paste-ready. Do
>    **not** edit this investigation file; create the findings file fresh. When done, print the full path
>    with `echo "WROTE: $(pwd)/macos-sharer-findings.md"` so I can find it.
>
> **Never** print, write, or transmit my actual access token, refresh token, or Keychain contents —
> not in the terminal, and **not in `macos-sharer-findings.md`**. Redact to prefixes (e.g.
> `sk-ant-oat01-…`). Only field names, HTTP statuses, and pass/fail belong in the output file.

---

## 📤 OUTPUT — agent: write this into a NEW file `macos-sharer-findings.md`

The agent must create `macos-sharer-findings.md` (a **separate** file, not this one) containing the
filled-in template below. That findings file is the only thing sent back to the dashboard owner.

If you (the human) want to scaffold the empty file yourself first, run this once in Terminal:

```bash
cat > macos-sharer-findings.md <<'EOF'
# macOS Sharer — Findings (paste-ready for the dashboard owner)

### Environment
- node --version:            <e.g. v22.3.0>
- claude --version:          <e.g. 2.1.0>
- macOS version:             <e.g. 14.5>
- ~/.claude/.credentials.json exists?      <yes/no>
- ~/.claude-pro/.credentials.json exists?  <yes/no>
- Where does macOS store the login?        <Keychain / file>

### Option A — claude setup-token → /api/oauth/usage
- `claude setup-token` succeeded?          <yes/no>
- Token prefix (redacted):                 <sk-ant-oat01-… / other / n/a>
- curl HTTP status from usage endpoint:    <200 / 401 / 403 / other>
- Response contained five_hour/seven_day/limits?   <yes/no>
- Redacted response field names seen:      <e.g. five_hour, seven_day, limits[]  |  or error body>
- VERDICT — does Option A work for usage?   <WORKS / FAILS>

### Option B — read-only Keychain (only if Option A failed)
- `security find-generic-password … -w` returned the JSON shape?   <yes/no/not tested>
- Is a rubric-compliant (non-rotating) design possible?            <yes/no + one-line why>

### 🔒 Rubric compliance
- Did any step write/rotate/delete the Keychain entry?   <no = pass / yes = FAIL, explain>
- Was CLAUDE_CODE_OAUTH_TOKEN ever set while running `claude`?  <no = pass / yes = FAIL>
- Any env vars persisted to rc files?                    <no = pass / yes = FAIL>
- Acceptance test — plain `claude` still works, no re-login?   <yes = pass / no = FAIL>

### Recommendation to the dashboard owner
<1–3 sentences: which option to build into the sharer for macOS, and any caveats. Remember: the
sharer needs the token via an environment variable or a file it can read — describe how you'd feed it
the credential without breaking the rubric.>
EOF
echo "WROTE: $(pwd)/macos-sharer-findings.md"
```

The block above both scaffolds and *documents* the exact structure of `macos-sharer-findings.md`. The
agent should fill every `<...>` placeholder with real (redacted) results, then hand the finished
`macos-sharer-findings.md` back. Send **that** file to the dashboard owner — it's everything needed to
upgrade the sharer's macOS credential path.

---

*Reminder for the human teammate: only the finished `macos-sharer-findings.md` needs to come back —
never your actual token or Keychain contents. If the agent ever asks you to paste a full
`sk-ant-oat01-…` token into a chat that leaves your machine, stop — that violates the rubric.*
