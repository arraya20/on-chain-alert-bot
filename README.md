# Pharos on-chain alert bot

Monitors Pharos Pacific (chain id 1672) for five conditions that matter to an
agent or a treasury, and delivers an alert to Telegram, Discord, Slack, or a
generic webhook when one of them becomes true.

This is a rewrite. The repository started as a generated scaffold that never
made a single network call, and the audit of that scaffold is in
[What was wrong](#what-was-wrong) below. Every number in this README was
produced by a command you can re-run.

```
npm run verify:chain    # re-checks every external fact against the live chain
npm test                # 52 offline tests, no network
npm run test:live       # 15 assertions against rpc.pharos.xyz
npm run watch:dry       # one real evaluation pass, sends nothing
```

## The rules

| rule              | reads                                        | fires when              |
| ----------------- | -------------------------------------------- | ----------------------- |
| `whale-native`    | blocks in the window, largest native transfer | >= 1,000 PROS          |
| `whale-usdc`      | `Transfer` logs on USDC                      | >= 1,000 USDC           |
| `treasury-low`    | `eth_getBalance` of EntryPoint v0.7          | <= 500 PROS             |
| `contract-paused` | `eth_call paused()` on USDC                  | returns true            |
| `chain-stall`     | head block timestamp vs local clock          | no block for 60s        |

Addresses are checked with `eth_getCode` and, for tokens, with `symbol()` and
`decimals()` before they are allowed into `src/rules.mjs`. `npm run verify:chain`
re-does that check and fails if anything moved:

```
ok   chainId is 1672 (Pacific) — got 1672
ok   usdc has code — 1798 bytes
ok   USDC symbol() — got "USDC"
ok   USDC decimals() — got 6
ok   EntryPoint v0.7 holds PROS — 1166064075980400000000 wei
ok   Transfer topic matches live logs — 46 logs
ok   getLogs accepts 1000 blocks (explicit toBlock)
ok   getLogs rejects 1001 blocks (explicit toBlock)
```

## Run it

No dependencies. Node 20 or newer.

```
npm run watch:dry      # evaluate once against the chain, deliver nothing
npm run watch:once     # evaluate once, deliver whatever triggered
npm run watch          # loop every 60s
```

For cron, `watch:once` is the intended entry point, because a cron tick already
gives you the loop and a crashed process does not take the schedule with it:

```
* * * * * cd /srv/on-chain-alert-bot && /usr/bin/node scripts/watch.mjs --once >> /var/log/alert-bot.log 2>&1
```

Exit codes are distinct on purpose: `0` pass completed, `2` the node could not
be read at all, `3` some rules failed to measure. A cron wrapper can alert on
non-zero without parsing text.

The watcher keeps a cursor in `.state/watch.json`, so each pass scans only new
blocks. It also records which rule it already alerted on, with a 30-minute
cooldown (`--cooldown`), so a condition that stays true does not page you every
minute. A failed delivery is **not** recorded, so it is retried on the next pass
instead of being silently swallowed by the cooldown.

After a long pause the catch-up is capped at 120 blocks (`--catchup`). Scanning
the full 998-block log limit costs about a thousand round trips and would alert
you about something twenty minutes old; the skipped span is printed and carried
in `--json` output as `skippedBlocks`, so the gap is stated rather than hidden.

## Delivery

Credentials come from the environment (or a `.env` file the watcher reads):

```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
ALERT_WEBHOOK_URL=https://your.endpoint/hook
ALERT_WEBHOOK_SECRET=...        # optional, sent as x-alert-secret
```

Test them with `npm run test:delivery`. It sends one message and prints what
the provider actually answered, not what we hoped:

```
ok   telegram  sent 200
FAIL discord   failed 404 — https://discord.com/... returned 404: Unknown Webhook
```

A dispatch result is `sent` only when the provider returned 2xx. Telegram
answers `200` with `{"ok":false}` for real errors, so that case is checked
explicitly and reported as `failed`. Webhook URLs must be `https`, and targets
in private, loopback, or link-local ranges are refused before any request is
made — the guard exists so a future change cannot turn this into a request
forgery primitive against a cloud metadata service.

## Dashboard

```
npm run serve     # http://127.0.0.1:8793
npm run deploy    # Cloudflare Pages, needs CLOUDFLARE_API_TOKEN
```

The page calls `GET /api/alert?window=60`, which evaluates the rules live and
returns the measurements. It renders exactly that and decides nothing: no
threshold is compared in the browser, and when the call fails the table is
cleared and replaced with the error. Two surfaces that compute their own verdict
will eventually disagree, and then both look broken.

There is deliberately no endpoint that sends a message. A public URL that
dispatches to Telegram is a spam cannon; delivery runs in the watcher, which
holds the credentials.

## What was wrong

The scaffold in this repository was internally consistent, plausible, and
green: `npm test` passed and the dashboard rendered a full monitoring view. It
also had never contacted the chain. Each finding below was measured, not
inferred.

**1. `dispatchAlert()` returned `{ status: "DELIVERED" }` without sending
anything.** The function built a payload, pushed it to a local array, and
returned. Its own test asserted `status === "DELIVERED"`, so the check passed by
construction. A notifier that reports delivery it did not perform is worse than
no notifier: the audit trail says the user was told.

**2. With no telemetry, every rule was compared against its own threshold.**
The evaluator did `rule.currentVal ?? rule.threshold` and then compared the
result to `rule.threshold`. For `>=` rules that is `threshold >= threshold`,
which is always true. Calling the endpoint with no parameters reported all
`>=` rules as `TRIGGERED` — an alert generated from nothing.

**3. The chain id was wrong.** The README and `src/monitor.mjs` said
`52026`. `eth_chainId` on `https://rpc.pharos.xyz` answers `0x688`, which is
**1672**. The three watched addresses had **no code and zero balance** on
Pharos — they are Ethereum mainnet addresses, one of them labelled "treasury"
and one "stPROS contract". The bot was watching wallets that do not exist on
the chain it claimed to monitor.

**4. Telegram escaping and parse mode disagreed.** The payload escaped all 18
MarkdownV2 reserved characters but set `parse_mode: "Markdown"` (legacy).
Escaping for one mode while declaring another means a rule named `USDC (paused)`
arrives with literal backslashes, and any unescaped reserved character breaks
the message outright.

**5. The dashboard displayed numbers that were never read.** Gas price `48
Gwei`, a `14.5k PROS` whale transfer, and a transaction hash were hard-coded
into the render. The real values at the time of measurement: gas price **10
Gwei and constant**, and no such transaction.

Two things this rewrite found by measuring rather than assuming:

**The `eth_getLogs` window is 1,000 blocks inclusive, and `"latest"` moves.**
The node rejects a range wider than 1,000 blocks. Sizing a request as
`fromBlock = head - 999, toBlock: "latest"` fails, because "latest" resolves
again at execution and the span is one or two blocks wider than the head you
read. `MAX_LOG_SPAN` is 999 and `getLogs()` always sends explicit hex block
numbers. Both bounds are asserted, so a one-sided check cannot hide the drift
again.

**Gas price cannot be the basis of a surge alert on Pacific.** `eth_gasPrice`
returns 10,000,000,000 wei and `baseFeePerGas` is pinned at the same value, with
zero priority fee. A "gas spike" rule would be a rule that can never fire, so
this bot watches chain liveness instead.

**The public node meters compute units, and a burst is enough to trip it.** A
60-block native scan at concurrency 8 failed with
`cu limit exceeded; Request too fast per second` on roughly one run in three —
reproducible, not a fluke. Two changes: the scan runs at concurrency 3, and the
client retries that specific answer with exponential backoff and jitter (three
attempts), while refusing to retry a parameter error, because retrying cannot
fix a malformed request. A 400-block window now completes in about 5s with all
five rules measured.

## What this does not do

- **No reorg handling.** Blocks arrive every ~0.93s and the watcher alerts on
  what the head says. An alert can, in principle, describe a block that is later
  reorganised out.
- **No historical backfill beyond 1,000 blocks**, and catch-up beyond 120
  blocks is deliberately dropped and reported. That is the node's limit for log
  queries; native transfer scanning has no such cap but costs one call per
  block, so the default window is 60 blocks and a pass takes about 4s.
- **Native transfer scanning is the expensive rule.** 60 blocks is 60
  `eth_getBlockByNumber` calls per pass, at concurrency 8. At a 60-second cron
  that is fine; a 5-second interval would be 12 requests per second and would
  deserve a rate limit you do not have.
- **`paused()` only works on tokens that implement it.** If the selector
  reverts, the rule reports `ERROR` — it does not fall back to "not paused".

## Files

```
src/rpc.mjs         JSON-RPC client; typed failures; 1,000-block log chunking
src/keccak.mjs      keccak-256, selectors, event topics — derived, not typed
src/abi.mjs         uint/bool/string/address decoding, exact unit formatting
src/metrics.mjs     readers: native transfers, ERC-20 transfers, balance, paused, head age
src/rules.mjs       rule definitions, compare(), evaluate() with TRIGGERED/OK/ERROR/SKIPPED
src/format.mjs      per-channel payloads, MarkdownV2 escaping
src/dispatch.mjs    HTTP delivery; "sent" only on 2xx; SSRF guard; token redaction
scripts/watch.mjs   the loop and the cron entry point, with cursor and cooldown
scripts/verify-chain.mjs  re-checks every external fact
scripts/test-delivery.mjs sends one message per configured channel
functions/api/alert.js    Pages Function: live evaluation, fail closed
public/             dashboard; renders the artefact, decides nothing
test/               unit (fixtures), api (stubbed transport), live (opt-in)
```

MIT.
