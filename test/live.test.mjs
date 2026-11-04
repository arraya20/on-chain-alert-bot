// Live suite: talks to rpc.pharos.xyz and www.pharosscan.xyz.
//
// Opt-in on purpose. A test suite that fails when the internet is flaky teaches
// people to ignore red, and then real red goes unnoticed.
//
//   npm run test:live

import { suite, test, assert, equal, rejects, run } from "./harness.mjs";
import { createClient, MAX_LOG_SPAN, RpcError } from "../src/rpc.mjs";
import { evaluate, DEFAULT_RULES, ADDRESSES, PACIFIC } from "../src/rules.mjs";
import { readTokenIdentity, readPaused, TRANSFER_TOPIC } from "../src/metrics.mjs";
import { topicToAddress, decodeUint } from "../src/abi.mjs";
import { formatUnits } from "../src/abi.mjs";

const client = createClient({ timeoutMs: 25_000 });
const head = await client.blockNumber();

suite("live: the network is the network this bot claims");
test("chainId is 1672", async () => {
  equal(await client.chainId(), PACIFIC.chainId);
});
test("head is above 22 million blocks", () => {
  assert(head > 22_000_000, `head was ${head}`);
});

suite("live: every rule target exists");
test("USDC has code", async () => {
  assert((await client.code(ADDRESSES.usdc)) !== "0x", "no code at USDC");
});
test("EntryPoint v0.7 has code", async () => {
  assert((await client.code(ADDRESSES.entryPointV07)) !== "0x", "no code at EntryPoint");
});
test("USDC really is USDC", async () => {
  const id = await readTokenIdentity(client, { address: ADDRESSES.usdc });
  equal(id.symbol, "USDC");
  equal(id.decimals, 6);
});
test("the treasury rule watches an address holding value", async () => {
  const bal = await client.balance(ADDRESSES.entryPointV07);
  assert(bal > 0n, `balance was ${bal}`);
});

suite("live: measurements agree with the node");
test("native transfer scan finds the same maximum the node reports", async () => {
  const to = head;
  const from = head - 9;
  const [reading, ...blocks] = await Promise.all([
    evaluate(client, [DEFAULT_RULES[0]], { fromBlock: from, toBlock: to }).then((r) => r.results[0]),
    ...Array.from({ length: 10 }, (_, i) => client.block(from + i, true)),
  ]);
  equal(reading.state === "TRIGGERED" || reading.state === "OK", true, `state was ${reading.state}: ${reading.error?.message}`);
  let max = 0n;
  for (const b of blocks) for (const tx of b?.transactions ?? []) if (BigInt(tx.value) > max) max = BigInt(tx.value);
  equal(BigInt(reading.observed), max, "the reported maximum must equal a recount over the same blocks");
});
test("USDC transfer logs decode into plausible transfers", async () => {
  const logs = await client.getLogs({ address: ADDRESSES.usdc, topics: [TRANSFER_TOPIC], fromBlock: head - 200, toBlock: head });
  assert(logs.length > 0, "no USDC transfers in 200 blocks — the rule would be untestable");
  const sample = logs.filter((l) => l.topics.length === 3).slice(0, 5);
  for (const l of sample) {
    const from = topicToAddress(l.topics[1]);
    const to = topicToAddress(l.topics[2]);
    const value = decodeUint(l.data);
    assert(/^0x[0-9a-f]{40}$/.test(from) && /^0x[0-9a-f]{40}$/.test(to), `bad topic addresses ${from} ${to}`);
    assert(value > 0n, "a decoded transfer must have a positive amount");
  }
});
test("paused() answers on USDC", async () => {
  const r = await readPaused(client, { address: ADDRESSES.usdc, symbol: "USDC" });
  equal(typeof r.value, "boolean");
});
test("gas price is 10 gwei and the base fee matches", async () => {
  const gas = await client.gasPrice();
  const block = await client.block(head, false);
  equal(gas, 10_000_000_000n, "gas price moved; the README's claim about a pinned fee is now wrong");
  equal(block.baseFeePerGas, gas);
});

suite("live: the documented log window, both bounds");
test("1,000 blocks is accepted with an explicit toBlock", async () => {
  const logs = await client.getLogs({ address: ADDRESSES.usdc, topics: [TRANSFER_TOPIC], fromBlock: head - MAX_LOG_SPAN, toBlock: head });
  assert(Array.isArray(logs), "expected an array");
});
test("1,001 blocks is rejected by the node", async () => {
  await rejects(
    () => client.rpc("eth_getLogs", [{ address: ADDRESSES.usdc, topics: [TRANSFER_TOPIC], fromBlock: "0x" + (head - MAX_LOG_SPAN - 1).toString(16), toBlock: "0x" + head.toString(16) }]),
    (e) => e instanceof RpcError && /too large|1,000/i.test(e.message),
  );
});

suite("live: the whole evaluation runs clean");
test("all five rules measure without error", async () => {
  const r = await evaluate(client, DEFAULT_RULES, { fromBlock: head - 30, toBlock: head });
  const errored = r.results.filter((x) => x.state === "ERROR");
  equal(errored.map((x) => `${x.ruleId}: ${x.error.message}`), []);
  equal(r.counts.error, 0);
  equal(r.degraded, false);
});
test("a small window still produces readable observations", async () => {
  const r = await evaluate(client, DEFAULT_RULES, { fromBlock: head - 30, toBlock: head });
  for (const result of r.results) {
    assert(result.observedFormatted, `${result.ruleId} had no formatted observation`);
    assert(result.thresholdFormatted, `${result.ruleId} had no formatted threshold`);
  }
});
test("the explorer answers", async () => {
  const res = await fetch(`https://www.pharosscan.xyz/`, { signal: AbortSignal.timeout(20_000) });
  assert(res.status === 200, `explorer returned ${res.status}`);
});

await run();
