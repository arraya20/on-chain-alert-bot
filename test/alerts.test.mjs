// Dedupe, retry and payload behaviour for the alert pipeline. Offline: the
// chain is a fixture and delivery is a stub that records what it was asked to
// send.

import { suite, test, assert, equal, run } from "./harness.mjs";
import { evaluate, DEFAULT_RULES, ADDRESSES } from "../src/rules.mjs";
import { deliver, emptyState, planAlerts, PENDING_MAX_ATTEMPTS, SEEN_TTL_MS } from "../src/alerts.mjs";
import { payloadFor, plainMessage } from "../src/format.mjs";
import { assertDeliverableUrl } from "../src/dispatch.mjs";
import { linkFor } from "../src/links.mjs";
import { TRANSFER_TOPIC, PAUSED_SELECTOR } from "../src/metrics.mjs";

const PROS = 10n ** 18n;
const hash = (n) => "0x" + n.toString(16).padStart(64, "0");
const addr = (n) => "0x" + n.toString(16).padStart(40, "0");
const tx = (hashValue, value) => ({ hash: hashValue, from: addr(1), to: addr(2), value: value.toString() });

function client({ blocks = {}, logs = [], balance = 10n ** 21n, paused = false } = {}) {
  const zero = "0x" + "0".repeat(64);
  const one = "0x" + "0".repeat(63) + "1";
  return {
    url: "fake",
    async blockNumber() { return 1000; },
    async gasPrice() { return 10n; },
    async balance() { return balance; },
    async code() { return "0x6001"; },
    async call(to, data) {
      if (data === PAUSED_SELECTOR) return paused ? one : zero;
      throw new Error("unknown selector");
    },
    async block(n) {
      const b = blocks[n];
      if (!b) return n === 1000 ? { number: n, timestamp: Math.floor(Date.now() / 1000), gasUsed: 0n, gasLimit: 1n, baseFeePerGas: null, transactions: [] } : null;
      return { number: n, timestamp: b.timestamp ?? Math.floor(Date.now() / 1000), gasUsed: 0n, gasLimit: 1n, baseFeePerGas: null, transactions: b.transactions ?? [] };
    },
    async getLogs({ fromBlock, toBlock }) {
      return logs.filter((l) => {
        const n = Number(BigInt(l.blockNumber));
        return n >= fromBlock && n <= toBlock;
      });
    },
  };
}

const transferLog = (txHash, logIndex, value) => ({
  address: ADDRESSES.usdc,
  topics: [TRANSFER_TOPIC, "0x" + "0".repeat(24) + "11".repeat(20), "0x" + "0".repeat(24) + "22".repeat(20)],
  data: "0x" + value.toString(16).padStart(64, "0"),
  blockNumber: "0x3e8",
  transactionHash: txHash,
  logIndex: "0x" + logIndex.toString(16),
});

const nativeRule = DEFAULT_RULES.find((r) => r.id === "whale-native");
const usdcRule = DEFAULT_RULES.find((r) => r.id === "whale-usdc");

async function measure(c, rules) {
  return (await evaluate(c, rules, { fromBlock: 1000, toBlock: 1000 })).results;
}

// A send stub that records calls and answers with a scripted status.
function sender(statuses = []) {
  const calls = [];
  const send = async (channel, result) => {
    calls.push({ channel, result });
    const status = statuses.shift() ?? "sent";
    return { channel, status, httpStatus: status === "sent" ? 200 : status === "failed" ? 500 : null, detail: status === "sent" ? null : status };
  };
  return { send, calls };
}

// ------------------------------------------------------------------ events

suite("events: each whale is its own alert");
test("two different whale transactions in one window are two alerts", async () => {
  const c = client({ blocks: { 1000: { transactions: [tx(hash(1), 5000n * PROS), tx(hash(2), 2000n * PROS)] } } });
  const results = await measure(c, [nativeRule]);
  equal(results[0].events.length, 2);
  const { send, calls } = sender();
  const out = await deliver({ results, state: emptyState(), send });
  equal(calls.length, 2);
  equal(out.deliveries.map((d) => d.status), ["sent", "sent"]);
  const txs = calls.map((x) => x.result.detail.largest.txHash).sort();
  equal(txs, [hash(1), hash(2)]);
});
test("the same transaction does not alert twice", async () => {
  const c = client({ blocks: { 1000: { transactions: [tx(hash(1), 5000n * PROS)] } } });
  const results = await measure(c, [nativeRule]);
  const first = sender();
  const a = await deliver({ results, state: emptyState(), send: first.send });
  equal(first.calls.length, 1);
  const second = sender();
  await deliver({ results, state: a.state, send: second.send });
  equal(second.calls.length, 0, "a sent event was alerted again");
});
test("a new whale right after another is not swallowed by a cooldown", async () => {
  const first = await measure(client({ blocks: { 1000: { transactions: [tx(hash(1), 5000n * PROS)] } } }), [nativeRule]);
  const a = await deliver({ results: first, state: emptyState(), send: sender().send, now: 1_000_000 });
  const second = await measure(client({ blocks: { 1000: { transactions: [tx(hash(2), 3000n * PROS)] } } }), [nativeRule]);
  const s = sender();
  await deliver({ results: second, state: a.state, send: s.send, now: 1_000_000 + 60_000 });
  equal(s.calls.length, 1, "the second, different whale was suppressed");
  equal(s.calls[0].result.detail.largest.txHash, hash(2));
});
test("an event alert reports its own value, not the window maximum", async () => {
  const c = client({ blocks: { 1000: { transactions: [tx(hash(1), 5000n * PROS), tx(hash(2), 1500n * PROS)] } } });
  const { send, calls } = sender();
  await deliver({ results: await measure(c, [nativeRule]), state: emptyState(), send });
  const small = calls.find((x) => x.result.detail.largest.txHash === hash(2));
  equal(small.result.observedFormatted, "1500 PROS");
  assert(small.result.link.url.endsWith(hash(2)), "the link must point at this event's transaction");
});
test("two token transfers in one transaction are distinct events", async () => {
  const logs = [transferLog(hash(7), 0, 2_000_000_000n), transferLog(hash(7), 1, 3_000_000_000n)];
  const results = await measure(client({ logs }), [usdcRule]);
  equal(results[0].events.length, 2);
  const { send, calls } = sender();
  await deliver({ results, state: emptyState(), send });
  equal(calls.length, 2);
  equal(calls.map((x) => x.result.observedFormatted).sort(), ["2000 USDC", "3000 USDC"]);
});
test("transfers below the threshold are not events", async () => {
  const c = client({ blocks: { 1000: { transactions: [tx(hash(1), 10n * PROS)] } } });
  const results = await measure(c, [nativeRule]);
  equal(results[0].state, "OK");
  equal(results[0].events, []);
});
test("events beyond the per-rule cap are counted, not hidden", async () => {
  const many = Array.from({ length: 40 }, (_, i) => tx(hash(100 + i), BigInt(2000 + i) * PROS));
  const results = await measure(client({ blocks: { 1000: { transactions: many } } }), [nativeRule]);
  equal(results[0].events.length, 25);
  equal(results[0].eventsTotal, 40);
  const out = await deliver({ results, state: emptyState(), send: sender().send });
  equal(out.truncated, 15);
});
test("seen events expire so state does not grow without bound", async () => {
  const results = await measure(client({ blocks: { 1000: { transactions: [tx(hash(1), 5000n * PROS)] } } }), [nativeRule]);
  const a = await deliver({ results, state: emptyState(), send: sender().send, now: 1_000 });
  equal(Object.keys(a.state.seen).length, 1);
  const b = await deliver({ results: [], state: a.state, send: sender().send, now: 1_000 + SEEN_TTL_MS + 1 });
  equal(Object.keys(b.state.seen).length, 0);
});

// ------------------------------------------------------------------ failures

suite("failed delivery is retried, and never recorded as sent");
test("a failed event is queued and retried on the next pass without rescanning", async () => {
  const results = await measure(client({ blocks: { 1000: { transactions: [tx(hash(1), 5000n * PROS)] } } }), [nativeRule]);
  const failing = sender(["failed"]);
  const a = await deliver({ results, state: emptyState(), send: failing.send, now: 1_000 });
  equal(a.state.pending.length, 1);
  equal(Object.keys(a.state.seen).length, 0, "a failed send must not be marked seen");

  // Next pass: the block range moved on, so the window has no events at all.
  const retry = sender();
  const b = await deliver({ results: [], state: a.state, send: retry.send, now: 2_000 });
  equal(retry.calls.length, 1, "the pending alert was not retried");
  equal(b.deliveries[0].retried, true);
  equal(b.state.pending.length, 0);
  equal(Object.keys(b.state.seen).length, 1);
});
test("a retried event is not planned a second time while pending", async () => {
  const results = await measure(client({ blocks: { 1000: { transactions: [tx(hash(1), 5000n * PROS)] } } }), [nativeRule]);
  const a = await deliver({ results, state: emptyState(), send: sender(["failed"]).send, now: 1_000 });
  const s = sender(["failed"]);
  await deliver({ results, state: a.state, send: s.send, now: 2_000 });
  equal(s.calls.length, 1, "the same event was both retried and re-planned");
});
test("a pending alert is abandoned after the attempt limit, and says so", async () => {
  const results = await measure(client({ blocks: { 1000: { transactions: [tx(hash(1), 5000n * PROS)] } } }), [nativeRule]);
  let state = (await deliver({ results, state: emptyState(), send: sender(["failed"]).send, now: 1_000 })).state;
  let dropped = [];
  for (let i = 0; i < PENDING_MAX_ATTEMPTS + 1; i += 1) {
    const out = await deliver({ results: [], state, send: sender(["failed"]).send, now: 2_000 + i });
    state = out.state;
    if (out.dropped.length) dropped = out.dropped;
  }
  equal(state.pending.length, 0);
  equal(dropped.length, 1);
  assert(/max attempts/.test(dropped[0].reason), dropped[0].reason);
});
test("an unconfigured channel does not mark the event seen or queue it forever", async () => {
  const results = await measure(client({ blocks: { 1000: { transactions: [tx(hash(1), 5000n * PROS)] } } }), [nativeRule]);
  const out = await deliver({ results, state: emptyState(), send: sender(["unconfigured"]).send });
  equal(Object.keys(out.state.seen).length, 0);
  equal(out.state.pending.length, 0);
  equal(out.deliveries[0].status, "unconfigured");
});
test("a failed state alert is not recorded, so the next pass sends it again", async () => {
  const results = await measure(client({ balance: 1n * PROS }), DEFAULT_RULES.filter((r) => r.id === "treasury-low"));
  equal(results[0].state, "TRIGGERED");
  const a = await deliver({ results, state: emptyState(), send: sender(["failed"]).send });
  equal(a.state.alerts["treasury-low"], undefined);
  const s = sender();
  await deliver({ results, state: a.state, send: s.send });
  equal(s.calls.length, 1);
});

// ------------------------------------------------------------------ state rules

suite("state rules alert once per episode, then at most once per cooldown");
const lowRule = DEFAULT_RULES.filter((r) => r.id === "treasury-low");
test("a condition that stays true alerts once inside the cooldown", async () => {
  const results = await measure(client({ balance: 1n * PROS }), lowRule);
  const a = await deliver({ results, state: emptyState(), send: sender().send, now: 1_000, cooldownMs: 60_000 });
  const s = sender();
  await deliver({ results, state: a.state, send: s.send, now: 30_000, cooldownMs: 60_000 });
  equal(s.calls.length, 0);
  await deliver({ results, state: a.state, send: s.send, now: 70_000, cooldownMs: 60_000 });
  equal(s.calls.length, 1, "the cooldown never expired");
});
test("a recovered condition that returns alerts immediately", async () => {
  const low = await measure(client({ balance: 1n * PROS }), lowRule);
  const a = await deliver({ results: low, state: emptyState(), send: sender().send, now: 1_000, cooldownMs: 3_600_000 });
  const fine = await measure(client({ balance: 10_000n * PROS }), lowRule);
  equal(fine[0].state, "OK");
  const b = await deliver({ results: fine, state: a.state, send: sender().send, now: 2_000, cooldownMs: 3_600_000 });
  const s = sender();
  await deliver({ results: low, state: b.state, send: s.send, now: 3_000, cooldownMs: 3_600_000 });
  equal(s.calls.length, 1, "a recurrence waited out a stale cooldown");
});

// ------------------------------------------------------------------ dry run

suite("dry run leaves no trace");
test("a dry run sends nothing and returns the state it was given", async () => {
  const results = await measure(client({ blocks: { 1000: { transactions: [tx(hash(1), 5000n * PROS)] } } }), [nativeRule]);
  const state = emptyState();
  const { send, calls } = sender();
  const out = await deliver({ results, state, send, dryRun: true });
  equal(calls.length, 0);
  assert(out.state === state, "dry run returned a modified copy");
  equal(out.deliveries[0].status, "dry-run");
  equal(state, emptyState());
});

// ------------------------------------------------------------------ payloads

suite("every alert links somewhere verifiable, and ERROR alerts are well formed");
test("every default rule carries an explorer link when measured", async () => {
  const results = await measure(client({ balance: 1n * PROS, paused: true, blocks: { 1000: { transactions: [tx(hash(1), 5000n * PROS)] } }, logs: [transferLog(hash(9), 0, 5_000_000_000n)] }), DEFAULT_RULES);
  for (const r of results) {
    assert(r.state !== "ERROR", `${r.ruleId} errored: ${r.error?.message}`);
    assert(r.link?.url?.startsWith("https://www.pharosscan.xyz/"), `${r.ruleId} has no explorer link`);
  }
  const byId = Object.fromEntries(results.map((r) => [r.ruleId, r.link.url]));
  assert(byId["whale-native"].includes("/tx/"), byId["whale-native"]);
  assert(byId["treasury-low"].includes("/address/"), byId["treasury-low"]);
  assert(byId["chain-stall"].includes("/block/"), byId["chain-stall"]);
});
test("a link is never built from a value that is not a hash or an address", () => {
  equal(linkFor({ target: "javascript:alert(1)" }), null);
  equal(linkFor({ detail: { largest: { txHash: "0x123" } } }), null);
  equal(linkFor({ detail: { headBlock: "7" } }), null);
});
test("alert text names the link for rules that have no transaction", async () => {
  const results = await measure(client({ balance: 1n * PROS }), lowRule);
  assert(plainMessage(results[0]).includes("/address/"), plainMessage(results[0]));
  assert(payloadFor("telegram", results[0]).text.includes("pharosscan.xyz/address/"), "telegram lost the link");
  assert(JSON.stringify(payloadFor("discord", results[0]).embeds).includes("pharosscan.xyz/address/"), "discord lost the link");
  assert(payloadFor("webhook", results[0]).data.link.includes("/address/"), "webhook lost the link");
});
test("an ERROR result renders with a comparator, a reason, and no 'undefined'", async () => {
  const broken = { ...client(), balance: async () => { throw new Error("node returned garbage"); } };
  const results = await measure(broken, lowRule);
  equal(results[0].state, "ERROR");
  equal(results[0].comparator, "<=");
  for (const channel of ["telegram", "discord", "slack", "webhook"]) {
    const p = payloadFor(channel, results[0]);
    const text = JSON.stringify(p);
    assert(!/undefined/.test(text), `${channel} payload contains 'undefined'`);
    assert(text.includes("node returned garbage"), `${channel} payload dropped the error message`);
  }
  assert(!/undefined/.test(plainMessage(results[0])), "plain message contains 'undefined'");
  const fields = payloadFor("discord", results[0]).embeds[0].fields;
  for (const f of fields) assert(typeof f.value === "string" && f.value.length > 0, `discord field ${f.name} is empty`);
});
test("an ERROR alert is planned once, not every pass", async () => {
  const broken = { ...client(), balance: async () => { throw new Error("down"); } };
  const results = await measure(broken, lowRule);
  const a = await deliver({ results, state: emptyState(), send: sender().send, now: 1_000, cooldownMs: 60_000 });
  equal(planAlerts(results, a.state, { now: 2_000, cooldownMs: 60_000 }).items.length, 0);
});

// ------------------------------------------------------------------ ssrf

suite("delivery urls: literals are refused, hostnames are not resolved");
test("IPv6 literals and localhost variants are refused", () => {
  for (const bad of ["https://[::1]/x", "https://[fc00::1]/x", "https://[fe80::1]/x", "https://[::ffff:10.0.0.1]/x", "https://localhost/x", "https://api.localhost/x", "https://10.0.0.5/x", "https://169.254.169.254/x"]) {
    let threw = false;
    try { assertDeliverableUrl(bad); } catch { threw = true; }
    assert(threw, `${bad} was accepted`);
  }
});
test("a normal provider url is accepted", () => {
  assertDeliverableUrl("https://discord.com/api/webhooks/1/abc");
  assertDeliverableUrl("https://hooks.slack.com/services/T/B/x");
});

await run();
