#!/usr/bin/env node
// The watcher. One pass = read head, evaluate rules over new blocks, dispatch
// whatever crossed a threshold, persist the cursor.
//
//   node scripts/watch.mjs --once            single pass, for cron
//   node scripts/watch.mjs --loop            long-running, interval from --interval
//   node scripts/watch.mjs --once --dry-run  evaluate, print, send nothing
//
// Options: --rpc <url>, --interval <s>, --cooldown <s>, --catchup <blocks>,
//          --state <path>, --json
//
// Exit codes:
//   0  pass completed (alerts may or may not have fired)
//   1  bad usage / config
//   2  the node could not be read at all (head unavailable)
//   3  pass completed but some rules failed to measure (degraded)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, describeError, RpcError } from "../src/rpc.mjs";
import { evaluate, DEFAULT_RULES, PACIFIC } from "../src/rules.mjs";
import { dispatch } from "../src/dispatch.mjs";
import { payloadFor, plainMessage } from "../src/format.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const valueOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

if (flag("help")) {
  console.log(readFileSync(join(HERE, "watch.mjs"), "utf8").split("\n").slice(1, 16).join("\n").replace(/^\/\/ ?/gm, ""));
  process.exit(0);
}

loadDotEnv(join(ROOT, ".env"));

const once = flag("once") || !flag("loop");
const dryRun = flag("dry-run");
const json = flag("json");
const intervalMs = Number(valueOf("interval", "60")) * 1000;
const cooldownMs = Number(valueOf("cooldown", "1800")) * 1000;
const statePath = valueOf("state", join(ROOT, ".state", "watch.json"));

const client = createClient({ url: valueOf("rpc", PACIFIC.rpc) });

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function readState() {
  if (!existsSync(statePath)) return { cursor: null, alerts: {}, passes: 0 };
  try {
    const s = JSON.parse(readFileSync(statePath, "utf8"));
    return { cursor: s.cursor ?? null, alerts: s.alerts ?? {}, passes: s.passes ?? 0 };
  } catch (err) {
    // A corrupt cursor means we do not know where we left off. Start from the
    // recent window rather than pretending we saw everything.
    console.error(`warn: state file unreadable (${err.message}); starting from a fresh window`);
    return { cursor: null, alerts: {}, passes: 0 };
  }
}

function writeState(state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}

function shouldAlert(result, state, now) {
  if (result.state !== "TRIGGERED" && result.state !== "ERROR") return false;
  const prev = state.alerts[result.ruleId];
  const key = result.state === "ERROR" ? "ERROR" : "TRIGGERED";
  if (!prev || prev.state !== key) return true;
  return now - (prev.at ?? 0) >= cooldownMs;
}

async function pass() {
  const started = Date.now();
  const state = readState();

  let head;
  try {
    head = await client.blockNumber();
  } catch (err) {
    const e = describeError(err);
    console.error(`fatal: cannot read head block from ${client.url} (${e.kind}: ${e.message})`);
    return { exitCode: 2, summary: { error: e } };
  }

  // Cold start looks back one window; after that only new blocks are scanned.
  // A long pause is capped: catching up over 998 blocks costs ~1,000 round
  // trips, and an alert about a whale that moved twenty minutes ago is not
  // worth twenty seconds of every pass. The skipped span is reported, never
  // silently swallowed.
  const windowBlocks = 60;
  const catchUpCap = Number(valueOf("catchup", "120"));
  let fromBlock;
  let skippedBlocks = 0;
  if (state.cursor == null) {
    fromBlock = Math.max(0, head - (windowBlocks - 1));
  } else {
    const want = state.cursor + 1;
    const span = head - want + 1;
    if (span > catchUpCap) {
      skippedBlocks = span - catchUpCap;
      fromBlock = head - (catchUpCap - 1);
    } else {
      fromBlock = want;
    }
  }

  let evaluation;
  try {
    evaluation = await evaluate(client, DEFAULT_RULES, { fromBlock, toBlock: head });
  } catch (err) {
    const e = describeError(err);
    console.error(`fatal: evaluation failed (${e.kind}: ${e.message})`);
    return { exitCode: 2, summary: { error: e } };
  }

  const now = Date.now();
  const toSend = evaluation.results.filter((r) => shouldAlert(r, state, now));
  const deliveries = [];

  for (const result of toSend) {
    if (dryRun) {
      deliveries.push({ ruleId: result.ruleId, channel: result.channel, status: "dry-run", httpStatus: null, detail: null });
      continue;
    }
    const payload = payloadFor(result.channel, result);
    const d = await dispatch(result.channel, payload);
    deliveries.push({ ruleId: result.ruleId, ...d });
    // Only remember the alert if it actually got out; a failed send must be
    // retried next pass, not swallowed by the cooldown.
    if (d.status === "sent") {
      state.alerts[result.ruleId] = { state: result.state, at: now, channel: result.channel };
    }
  }

  state.cursor = head;
  state.passes = (state.passes ?? 0) + 1;
  writeState(state);

  const exitCode = evaluation.counts.error === evaluation.results.length ? 2 : evaluation.degraded ? 3 : 0;
  const summary = {
    at: new Date(started).toISOString(),
    network: `chain ${PACIFIC.chainId}`,
    head,
    blockRange: evaluation.blockRange,
    skippedBlocks,
    counts: evaluation.counts,
    degraded: evaluation.degraded,
    alertsQueued: toSend.length,
    deliveries,
    durationMs: Date.now() - started,
  };

  if (json) {
    console.log(JSON.stringify({ summary, results: evaluation.results }, null, 2));
  } else {
    printHuman(summary, evaluation, toSend, dryRun);
  }
  return { exitCode, summary };
}

function printHuman(summary, evaluation, toSend, isDry) {
  const c = evaluation.counts;
  console.log(
    `[watch] block ${summary.head} · ${c.triggered} triggered · ${c.ok} ok · ${c.error} error · ${summary.durationMs}ms${isDry ? " · dry-run" : ""}`,
  );
  for (const r of evaluation.results) {
    const mark = r.state === "TRIGGERED" ? "!" : r.state === "ERROR" ? "x" : r.state === "SKIPPED" ? "-" : " ";
    const obs = r.observedFormatted ?? (r.error ? `${r.error.kind}: ${r.error.message}` : r.reason ?? "");
    console.log(`  ${mark} ${r.ruleId.padEnd(16)} ${String(r.state).padEnd(10)} ${obs}`);
  }
  for (const d of summary.deliveries) {
    const line = d.status === "sent" ? "sent" : `${d.status}${d.httpStatus ? ` ${d.httpStatus}` : ""}`;
    console.log(`  → ${d.ruleId} via ${d.channel}: ${line}${d.detail ? ` (${d.detail})` : ""}`);
  }
  if (summary.skippedBlocks > 0) {
    console.log(`  ! ${summary.skippedBlocks} blocks were skipped (catch-up cap); raise --catchup to widen the lookback`);
  }
  if (evaluation.degraded) console.log("  ! some rules could not be measured; those are not 'ok'");
}

async function main() {
  if (once) {
    const { exitCode } = await pass();
    process.exit(exitCode);
  }

  console.log(`[watch] loop mode · every ${intervalMs / 1000}s · cooldown ${cooldownMs / 1000}s · rpc ${client.url}`);
  let stopping = false;
  const stop = () => {
    stopping = true;
    console.log("[watch] stopping after current pass");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    const { exitCode } = await pass();
    if (exitCode === 2) console.error("[watch] node unreachable; will retry next interval");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Only run when invoked directly; the test suite imports pass().
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    if (err instanceof RpcError) console.error(`fatal: ${err.kind}: ${err.message}`);
    else console.error(`fatal: ${err?.stack || err}`);
    process.exit(1);
  });
}

export { pass };
