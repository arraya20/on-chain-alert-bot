---
name: on-chain-alert-bot
description: Use when monitoring Pharos Pacific on-chain conditions or extending this alert bot's rules. Covers running the watcher, verifying targets, and adding a rule.
version: 2.0.0
tags:
  - monitoring
  - alerts
  - pharos
  - evm
---

# On-chain alert bot (Pharos Pacific)

## When to use this

- Running or scheduling the watcher.
- Adding, retargeting, or retiring a rule.
- A rule reports `ERROR`, or an expected alert did not arrive.
- Re-checking whether the addresses in `src/rules.mjs` still exist.

Chain is **1672** (`0x688`), RPC `https://rpc.pharos.xyz`, explorer
`https://www.pharosscan.xyz`. Block time is about **0.93s**.

## Verify before you trust anything

```
npm run verify:chain     # checks against the live chain
npm test                 # 75 offline tests, no network
npm run test:live        # assertions against the live chain
npm run watch:dry        # one real evaluation, sends nothing
```

`verify:chain` is the one to run first after any change to addresses or units.
It fails loudly if an address has no code, if USDC is not USDC, or if the log
window boundary moved.

## Run it

```
node scripts/watch.mjs --once                 # one pass, deliver what triggered
node scripts/watch.mjs --once --dry-run       # one pass, send nothing
node scripts/watch.mjs --loop --interval 60   # long-running
```

Cron is the recommended production shape, because a crashed process does not
take the schedule with it:

```
* * * * * cd /srv/on-chain-alert-bot && node scripts/watch.mjs --once >> /var/log/alert-bot.log 2>&1
```

Exit codes: `0` pass completed, `1` bad usage, `2` node unreadable, `3` some
rules could not be measured. Alert on non-zero without parsing text.

State lives in `.state/watch.json`: cursor, per-rule condition cooldown, seen
event keys (6h TTL) and the pending retry queue. Delete it to force a cold start
over the most recent window. `--dry-run` never writes it.

## Adding a rule

1. Pick the metric from `READERS` in `src/rules.mjs` — `native_transfer_max`,
   `erc20_transfer_max`, `native_balance`, `contract_paused`, `chain_head_age`,
   `gas_price`. A new metric means a new reader in `src/metrics.mjs` that either
   returns `{ value, unit, evidence }` or throws.
2. Confirm the target exists: `eth_getCode` non-empty, and for a token, check
   `symbol()` and `decimals()` match what the rule name claims.
3. Set `unit` and `decimals` to match the metric. `formatObserved` derives the
   human string from them, so a wrong `decimals` produces an alert with a number
   off by a factor of a million.
4. Set `windowBlocks` only for rules that scan history. Rules without it are
   measured on every tick, including ticks where the head has not moved.
5. Run `npm run verify:chain` — it asserts every default rule names a metric
   that has a reader.

## Pitfalls, each one measured

- **`eth_getLogs` accepts at most 1,000 blocks, counted inclusively.** A range
  is rejected when `toBlock - fromBlock >= 1000`. Half-open reasoning gets this
  wrong in the quiet direction: `head - 999 .. head` is 1,000 blocks and works,
  `head - 1000 .. head` does not.
- **Never pass `toBlock: "latest"` when sizing against a head you read
  yourself.** The node resolves "latest" again at execution, so the span grows
  by however many blocks arrived in between and a request you sized as exactly
  at the limit is rejected. `getLogs()` sends explicit hex block numbers for
  this reason.
- **Telegram returns HTTP 200 with `{"ok":false}` for real errors.** Treating
  the status code as the outcome reports delivery that did not happen.
- **Telegram escaping and parse mode must agree.** `escapeMarkdownV2` escapes 18
  reserved characters; sending that text with `parse_mode: "Markdown"` (legacy)
  renders the backslashes. The pair is `MarkdownV2` + MarkdownV2 escaping.
- **No telemetry is not a measurement of zero.** A reader that returns
  `undefined` must become `ERROR`, never `OK` and never `TRIGGERED`. A rule
  compared against its own threshold reports `>=` as true forever.
- **Gas price cannot spike on Pacific.** `eth_gasPrice` and `baseFeePerGas` are
  pinned at 10 gwei with zero priority fee. Do not build a fee-market alert here;
  watch chain liveness instead.
- **Native PROS transfers emit no log.** `eth_getLogs` will never show them;
  they require scanning blocks (one call per block, concurrency 3).
- **Addresses copied from Ethereum mainnet look valid and are empty here.** A
  checksum-valid address with no code and zero balance is the signature of a
  lifted constant. Verify with `eth_getCode` before shipping a rule.
- **The public node rate-limits by compute unit.** `cu limit exceeded; Request
  too fast per second` showed up on roughly one in three 60-block scans at
  concurrency 8. The client retries it with backoff; block-scan concurrency is
  3 so the retry does not become the burst. Do not retry a parameter
  error — only this class of answer is transient.

## Failure behaviour to preserve

- `evaluate()` returns exactly one of `TRIGGERED`, `OK`, `ERROR`, `SKIPPED`.
  `SKIPPED` means "nothing new to scan", never "fine".
- `dispatch()` returns `sent` only after a 2xx, plus `failed`, `unconfigured`,
  or `blocked`. There is no `delivered`: only the provider can claim that.
- Whale events dedupe per event (rule + tx hash, + log index for tokens), never
  by a per-rule timer. Condition rules (balance, paused, stall, ERROR) alert once
  per episode, then once per cooldown; an OK measurement ends the episode.
- A failed send is never recorded as sent. Failed events go to `pending` and are
  retried before anything new, even after the cursor passed their block.
- Every alert has an explorer link (`src/links.mjs`); ERROR alerts carry the
  comparator and the error text. Never print or send `undefined`.
- The dashboard renders the API payload and computes nothing. When the API
  fails it clears the table and shows the error.

## Delivery channels

`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, `DISCORD_WEBHOOK_URL`,
`SLACK_WEBHOOK_URL`, `ALERT_WEBHOOK_URL` (+ optional `ALERT_WEBHOOK_SECRET`).
Check wiring with `npm run test:delivery`, which prints the provider's own
response. Webhook targets must be `https`; `localhost`, private IPv4, link-local
and IPv6 literals are refused. Hostnames are not resolved.
