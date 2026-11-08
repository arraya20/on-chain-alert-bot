// Offline suite. No network: every chain response here is a fixture, so this
// file runs on a plane and in CI. The live suite is separate (test/live.test.mjs)
// because tests that need the internet must be opt-in, not flaky-by-default.

import { suite, test, assert, equal, rejects, run } from "./harness.mjs";
import { keccak256, selectorOf, eventTopicOf, selfTest, VECTORS } from "../src/keccak.mjs";
import { encodeUint, decodeUint, decodeBool, decodeString, formatUnits, topicToAddress } from "../src/abi.mjs";
import { compare, evaluate, DEFAULT_RULES, ADDRESSES, formatObserved } from "../src/rules.mjs";
import { escapeMarkdownV2, payloadFor, plainMessage } from "../src/format.mjs";
import { dispatch, assertDeliverableUrl, redactUrl, channelConfig } from "../src/dispatch.mjs";
import { createClient, MAX_LOG_SPAN } from "../src/rpc.mjs";
import { TRANSFER_TOPIC, PAUSED_SELECTOR } from "../src/metrics.mjs";

// ---------------------------------------------------------------- fixtures

function fakeClient({ blocks = {}, logs = [], balances = {}, codes = {}, calls = {}, head = 1000, gas = 10_000_000_000n } = {}) {
  return {
    url: "fake",
    async blockNumber() { return head; },
    async chainId() { return 1672; },
    async gasPrice() { return gas; },
    async balance(a) { return BigInt(balances[String(a).toLowerCase()] ?? 0); },
    async code(a) { return codes[String(a).toLowerCase()] ?? "0x"; },
    async call(to, data) {
      const v = calls[String(to).toLowerCase()]?.[data];
      if (v === undefined) throw new Error("execution reverted: unknown selector");
      return v;
    },
    async block(n, withTxs) {
      const b = blocks[n];
      if (!b) return null;
      return {
        number: n,
        timestamp: b.timestamp ?? 1_700_000_000,
        gasUsed: 0n,
        gasLimit: 30_000_000n,
        baseFeePerGas: 10_000_000_000n,
        transactions: b.transactions ?? [],
      };
    },
    async getLogs({ fromBlock, toBlock }) {
      return logs.filter((l) => {
        const n = Number(BigInt(l.blockNumber));
        return n >= fromBlock && n <= toBlock;
      });
    },
    async rpc(method) { throw new Error(`rpc ${method} not stubbed`); },
  };
}

const tx = (value, hash = "0x" + "ab".repeat(32)) => ({
  hash,
  from: "0x" + "11".repeat(20),
  to: "0x" + "22".repeat(20),
  value: value.toString(),
});

// ---------------------------------------------------------------- keccak/abi

suite("keccak and ABI: derived, not typed");
test("published vectors pass", () => {
  const failures = selfTest();
  equal(failures, [], "selfTest reported failures");
  assert(VECTORS.length >= 6, `only ${VECTORS.length} vectors`);
});
test("selector for transfer(address,uint256) is the well-known 0xa9059cbb", () => {
  equal(selectorOf("transfer(address,uint256)"), "0xa9059cbb");
});
test("Transfer topic is 0xddf252ad…", () => {
  equal(eventTopicOf("Transfer(address,address,uint256)"), "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
});
test("paused() selector is 0x5c975abb", () => {
  equal(PAUSED_SELECTOR, "0x5c975abb");
});
test("uint round-trips and string decoding handles offsets", () => {
  equal(decodeUint(encodeUint(123456789n)), 123456789n);
  const head = encodeUint(32n).slice(2);
  const len = encodeUint(4n).slice(2);
  const body = Buffer.from("USDC").toString("hex").padEnd(64, "0");
  equal(decodeString("0x" + head + len + body), "USDC");
});
test("bool decoding reads any non-zero word as true, which is the safe direction", () => {
  equal(decodeBool("0x" + "0".repeat(64)), false);
  equal(decodeBool("0x" + "0".repeat(63) + "1"), true);
  // A malformed answer must not read as "not paused".
  equal(decodeBool("0x" + "0".repeat(63) + "2"), true);
});
test("formatUnits is exact for 18 and 6 decimals", () => {
  equal(formatUnits(1_166_064_075_980_400_000_000n, 18), "1166.0640759804");
  equal(formatUnits(1_000_000_000n, 6), "1000");
  equal(formatUnits(0n, 18), "0");
});

// ---------------------------------------------------------------- compare

suite("compare: an impossible comparison is an error, not false");
test("bigints compare across the string boundary", () => {
  assert(compare(2000n, ">=", "1000") === true, "2000 >= 1000");
  assert(compare("999", ">=", 1000n) === false, "999 >= 1000");
  assert(compare(0n, "<=", "500") === true, "0 <= 500");
});
test("booleans only allow equality", () => {
  assert(compare(true, "==", true) === true);
  assert(compare(false, "==", true) === false);
  assert(compare(true, "!=", false) === true);
});
test("ordering a boolean throws rather than inventing an answer", async () => {
  await rejects(() => Promise.resolve(compare(true, ">", 1)), (e) => /undefined for booleans/.test(e.message));
});
test("ordering a non-numeric string throws", async () => {
  await rejects(() => Promise.resolve(compare("abc", ">", "abd")), (e) => /undefined for strings/.test(e.message));
});
test("an unknown comparator throws", async () => {
  await rejects(() => Promise.resolve(compare(1, "=~", 1)), (e) => /unknown comparator/.test(e.message));
});

// ---------------------------------------------------------------- evaluate

suite("evaluate: silence is not health");
test("a rule above threshold is TRIGGERED with a real observation", async () => {
  const client = fakeClient({ blocks: { 1000: { transactions: [tx(2000n * 10n ** 18n)] } } });
  const r = await evaluate(client, [DEFAULT_RULES[0]], { fromBlock: 1000, toBlock: 1000 });
  equal(r.results[0].state, "TRIGGERED");
  equal(r.results[0].observedFormatted, "2000 PROS");
  equal(r.counts.triggered, 1);
});
test("a rule below threshold is OK, and reports what it measured", async () => {
  const client = fakeClient({ blocks: { 1000: { transactions: [tx(10n * 10n ** 18n)] } } });
  const r = await evaluate(client, [DEFAULT_RULES[0]], { fromBlock: 1000, toBlock: 1000 });
  equal(r.results[0].state, "OK");
  equal(r.results[0].observedFormatted, "10 PROS");
});
// This is the regression that matters most: the scaffold compared a rule's
// threshold against itself when no telemetry existed, so every ">=" rule
// reported TRIGGERED on fabricated data.
test("a rule whose reader fails is ERROR, never TRIGGERED and never OK", async () => {
  const client = fakeClient({});
  const r = await evaluate(client, [DEFAULT_RULES[0]], { fromBlock: 1000, toBlock: 1000 });
  equal(r.results[0].state, "ERROR");
  equal(r.counts.triggered, 0);
  equal(r.counts.ok, 0);
  equal(r.degraded, true);
  assert(r.results[0].observedFormatted === undefined, "an unmeasured rule must not carry a formatted observation");
});
test("an unimplemented metric is a config ERROR with the metric named", async () => {
  const client = fakeClient({});
  const rule = { id: "x", name: "x", metric: "not_a_metric", comparator: ">", threshold: 1, unit: "count", channel: "webhook" };
  const r = await evaluate(client, [rule], { fromBlock: 1, toBlock: 2 });
  equal(r.results[0].state, "ERROR");
  equal(r.results[0].error.kind, "config");
  assert(/not_a_metric/.test(r.results[0].error.message), "metric name must appear in the error");
});
test("a broken reader surfaces as ERROR, never as a zero measurement", async () => {
  const rule = { id: "y", name: "y", metric: "native_balance", target: "0x" + "00".repeat(20), comparator: "<=", threshold: "1", unit: "wei", decimals: 18, channel: "webhook" };
  // balance() normally returns 0n, which is a legitimate measurement of zero.
  // Returning undefined is not: it must become ERROR, and 0 <= 1 must not be
  // the answer that gets reported.
  const broken = { ...fakeClient({}), balance: async () => undefined, code: async () => "0x" };
  const r = await evaluate(broken, [rule], { fromBlock: 1, toBlock: 1 });
  equal(r.results[0].state, "ERROR");
  equal(r.counts.ok, 0);
  assert(r.results[0].error.message.length > 0, "an ERROR must carry a message");
});
test("window rules SKIP when there are no new blocks, point-in-time rules still measure", async () => {
  const client = fakeClient({
    head: 1000,
    balances: { [ADDRESSES.entryPointV07.toLowerCase()]: 10n ** 21n },
    codes: { [ADDRESSES.entryPointV07.toLowerCase()]: "0x6001" },
    calls: { [ADDRESSES.usdc.toLowerCase()]: { [PAUSED_SELECTOR]: "0x" + "0".repeat(64) } },
  });
  const r = await evaluate(client, DEFAULT_RULES, { fromBlock: 1001, toBlock: 1000 });
  const byId = Object.fromEntries(r.results.map((x) => [x.ruleId, x]));
  equal(byId["whale-native"].state, "SKIPPED");
  equal(byId["whale-usdc"].state, "SKIPPED");
  equal(byId["treasury-low"].state, "OK");
  equal(byId["contract-paused"].state, "OK");
});
test("every default rule names a metric that has a reader", async () => {
  const client = fakeClient({});
  const r = await evaluate(client, DEFAULT_RULES, { fromBlock: 1, toBlock: 1 });
  const configErrors = r.results.filter((x) => x.error?.kind === "config");
  equal(configErrors.map((x) => x.ruleId), []);
});
test("threshold formatting matches the unit, so the report reads correctly", () => {
  equal(formatObserved(DEFAULT_RULES[0], { value: BigInt(DEFAULT_RULES[0].threshold) }), "1000 PROS");
  equal(formatObserved(DEFAULT_RULES[2], { value: BigInt(DEFAULT_RULES[2].threshold) }), "500 PROS");
  equal(formatObserved(DEFAULT_RULES[3], { value: true }), "true");
  equal(formatObserved(DEFAULT_RULES[4], { value: 60 }), "60s");
});

// ---------------------------------------------------------------- format

suite("format: Telegram escaping matches the parse mode it sends");
test("every reserved MarkdownV2 character is escaped", () => {
  const reserved = "_*[]()~`>#+-=|{}.!";
  for (const ch of reserved) {
    equal(escapeMarkdownV2(ch), "\\" + ch, `char ${JSON.stringify(ch)}`);
  }
  equal(escapeMarkdownV2("\\"), "\\\\");
});
test("a rule name with parentheses survives intact", () => {
  const out = escapeMarkdownV2("USDC (paused)");
  equal(out, "USDC \\(paused\\)");
});
test("telegram payload declares MarkdownV2, the mode its escaping assumes", () => {
  const r = { state: "TRIGGERED", name: "USDC (paused)", observedFormatted: "true", comparator: "==", thresholdFormatted: "true", target: ADDRESSES.usdc, why: "x" };
  const p = payloadFor("telegram", r);
  equal(p.parse_mode, "MarkdownV2");
  // The only legitimate raw parentheses are the delimiters of the link url.
  const withoutLink = p.text.replace(/\]\([^)]*\)/g, "]");
  assert(!/\(/.test(withoutLink.replace(/\\\(/g, "")), "an unescaped parenthesis leaked into the body");
  assert(p.text.includes("USDC \\(paused\\)"), p.text);
});
test("other channels carry the same numbers", () => {
  const r = { state: "TRIGGERED", name: "n", observedFormatted: "1,166 PROS", comparator: "<=", thresholdFormatted: "500 PROS", target: ADDRESSES.entryPointV07, why: "w", severity: "critical" };
  const d = payloadFor("discord", r);
  assert(JSON.stringify(d.embeds).includes("1,166 PROS"), "discord lost the observation");
  const s = payloadFor("slack", r);
  assert(JSON.stringify(s.blocks).includes("1,166 PROS"), "slack lost the observation");
  const w = payloadFor("webhook", r);
  equal(w.data.observedFormatted, "1,166 PROS");
  equal(w.event, "pharos.alert");
});
test("plain message links the transaction on the explorer", () => {
  const r = { state: "TRIGGERED", name: "n", observedFormatted: "1 PROS", comparator: ">=", thresholdFormatted: "0", detail: { largest: { txHash: "0x" + "cd".repeat(32) } } };
  const text = plainMessage(r, { at: "2026-11-05T00:00:00Z" });
  assert(text.includes("https://www.pharosscan.xyz/tx/0xcdcd"), text);
});

// ---------------------------------------------------------------- dispatch

suite("dispatch: 'sent' means a provider answered 2xx");
const okFetch = (status = 200, body = '{"ok":true,"result":{}}') => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });

test("no credentials is unconfigured, not sent", async () => {
  const r = await dispatch("telegram", { text: "x" }, { env: {}, fetchImpl: okFetch() });
  equal(r.status, "unconfigured");
  equal(r.httpStatus, null);
});
test("2xx is sent", async () => {
  const r = await dispatch("telegram", { text: "x" }, { env: { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1" }, fetchImpl: okFetch() });
  equal(r.status, "sent");
  equal(r.httpStatus, 200);
});
test("500 is failed, with the status preserved", async () => {
  const r = await dispatch("discord", { content: "x" }, { env: { DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/x" }, fetchImpl: okFetch(500, "boom") });
  equal(r.status, "failed");
  equal(r.httpStatus, 500);
});
test("a thrown network error is failed, not sent", async () => {
  const r = await dispatch("webhook", {}, {
    env: { ALERT_WEBHOOK_URL: "https://example.com/hook" },
    fetchImpl: async () => { const e = new Error("fetch failed"); e.cause = { code: "ENOTFOUND" }; throw e; },
  });
  equal(r.status, "failed");
  assert(/ENOTFOUND/.test(r.detail), r.detail);
});
// Telegram answers 200 with {ok:false} for real errors. Trusting the status
// alone would report a delivery that never happened.
test("telegram 2xx with ok:false is failed", async () => {
  const r = await dispatch("telegram", { text: "x" }, { env: { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1" }, fetchImpl: okFetch(200, '{"ok":false,"description":"chat not found"}') });
  equal(r.status, "failed");
  assert(/chat not found/.test(r.detail), r.detail);
});
test("http and cloud-metadata targets are blocked before any request is made", async () => {
  let called = false;
  const spy = async () => { called = true; return { ok: true, status: 200, text: async () => "{}" }; };
  const plain = await dispatch("webhook", {}, { env: { ALERT_WEBHOOK_URL: "http://example.com/hook" }, fetchImpl: spy });
  equal(plain.status, "blocked");
  const meta = await dispatch("webhook", {}, { env: { ALERT_WEBHOOK_URL: "https://169.254.169.254/latest/meta-data" }, fetchImpl: spy });
  equal(meta.status, "blocked");
  const local = await dispatch("webhook", {}, { env: { ALERT_WEBHOOK_URL: "https://localhost:8080/x" }, fetchImpl: spy });
  equal(local.status, "blocked");
  const creds = await dispatch("webhook", {}, { env: { ALERT_WEBHOOK_URL: "https://user:pw@example.com/hook" }, fetchImpl: spy });
  equal(creds.status, "blocked");
  equal(called, false, "a blocked url must not be requested");
});
test("the telegram bot token never appears in a failure detail", async () => {
  const r = await dispatch("telegram", { text: "x" }, {
    env: { TELEGRAM_BOT_TOKEN: "123456:SUPERSECRET", TELEGRAM_CHAT_ID: "1" },
    fetchImpl: async () => ({ ok: false, status: 400, text: async () => "bad" }),
  });
  assert(!r.detail.includes("SUPERSECRET"), r.detail);
  assert(r.detail.includes("REDACTED"), r.detail);
});
test("redactUrl leaves non-telegram urls alone", () => {
  equal(redactUrl("https://discord.com/api/webhooks/1/x"), "https://discord.com/api/webhooks/1/x");
});
test("channelConfig refuses to invent a url", () => {
  equal(channelConfig("telegram", { TELEGRAM_BOT_TOKEN: "t" }), null, "token without chat id must not be configured");
  equal(channelConfig("discord", {}), null);
  equal(channelConfig("carrier-pigeon", {}), null);
});

// ---------------------------------------------------------------- getLogs

suite("rpc.getLogs: chunks the range and never uses 'latest'");
test("a 3,000 block request becomes chunks the node accepts, with no gaps", async () => {
  const calls = [];
  const stub = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.params[0]);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: [] }), text: async () => "{}" };
  };
  const client = createClient({ url: "https://rpc.test", fetchImpl: stub });
  await client.getLogs({ address: ADDRESSES.usdc, topics: [TRANSFER_TOPIC], fromBlock: 1000, toBlock: 3999 });

  equal(calls.length, 3, `expected 3 chunks, got ${calls.length}`);
  let expectedFrom = 1000;
  for (const p of calls) {
    assert(p.toBlock !== "latest", "'latest' re-resolves the head and widens the range past the cap");
    assert(/^0x[0-9a-f]+$/.test(p.fromBlock) && /^0x[0-9a-f]+$/.test(p.toBlock), "blocks must be explicit hex");
    const from = Number(BigInt(p.fromBlock));
    const to = Number(BigInt(p.toBlock));
    equal(from, expectedFrom, "chunks must be contiguous");
    assert(to - from + 1 <= MAX_LOG_SPAN + 1, `chunk of ${to - from + 1} blocks exceeds the accepted width`);
    expectedFrom = to + 1;
  }
  equal(expectedFrom, 4000, "the last chunk must reach toBlock exactly");
});
test("the client refuses a non-https rpc url instead of sending to it", async () => {
  await rejects(() => Promise.resolve(createClient({ url: "http://rpc.test" })), (e) => /must be https/.test(e.message));
});
test("a json-rpc error keeps the node's own message", async () => {
  const stub = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "block range too large" } }),
  });
  const client = createClient({ url: "https://rpc.test", fetchImpl: stub });
  const err = await rejects(() => client.blockNumber(), (e) => e.kind === "rpc");
  assert(/block range too large/.test(err.message), `lost the node message: ${err.message}`);
});

suite("rpc: the node's compute-unit limit is transient and retried");
const rateLimited = () => ({
  ok: true,
  status: 200,
  json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "cu limit exceeded; Request too fast per second." } }),
  text: async () => "{}",
});
test("a cu-limit answer is retried and the second attempt wins", async () => {
  let n = 0;
  const stub = async () => {
    n += 1;
    if (n < 2) return rateLimited();
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x688" }), text: async () => "{}" };
  };
  const client = createClient({ url: "https://rpc.test", fetchImpl: stub, baseDelayMs: 1 });
  equal(await client.chainId(), 1672);
  equal(n, 2, "should have retried exactly once");
});
test("a persistent cu-limit gives up after maxRetries and reports the reason", async () => {
  let n = 0;
  const stub = async () => { n += 1; return rateLimited(); };
  const client = createClient({ url: "https://rpc.test", fetchImpl: stub, baseDelayMs: 1, maxRetries: 2 });
  const err = await rejects(() => client.blockNumber(), (e) => /cu limit/.test(e.message));
  equal(n, 3, "one attempt plus two retries");
  assert(/cu limit/.test(err.message), err.message);
});
test("a parameter error is not retried, because retrying cannot fix it", async () => {
  let n = 0;
  const stub = async () => {
    n += 1;
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid argument 0: hex string has odd length" } }), text: async () => "{}" };
  };
  const client = createClient({ url: "https://rpc.test", fetchImpl: stub, baseDelayMs: 1, maxRetries: 3 });
  await rejects(() => client.blockNumber(), (e) => /odd length/.test(e.message));
  equal(n, 1, "a deterministic error must not be retried");
});

// ---------------------------------------------------------------- README

suite("no fabricated chain facts in the tree");
// Code must never claim the wrong chain id. Prose may quote it, but only on a
// line that also states the right one, which is what the audit section does.
test("no module claims chain id 52026", async () => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = new URL("..", import.meta.url).pathname;
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git" || name === ".state" || name === "test") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(mjs|js|html|toml)$/.test(name)) {
        if (readFileSync(p, "utf8").includes("52026")) hits.push(p);
      }
    }
  };
  for (const dir of ["src", "public", "functions", "scripts"]) walk(join(root, dir));
  equal(hits, [], "chain id 52026 is not Pharos Pacific (1672)");
});
test("README mentions the wrong chain id only next to the right one", async () => {
  const { readFileSync } = await import("node:fs");
  const lines = readFileSync(new URL("../README.md", import.meta.url), "utf8").split("\n");
  const bad = lines.filter((l) => l.includes("52026") && !l.includes("1672") && !l.includes("0x688"));
  equal(bad, [], "a line quotes the wrong chain id without correcting it");
});

await run();
