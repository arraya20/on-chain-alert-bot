#!/usr/bin/env node
// Re-checks every external fact this bot depends on. Run it when the chain or
// the docs change, and in CI if you have network.
//
//   node scripts/verify-chain.mjs
//
// Exits 1 on the first failed assertion set so a stale rule cannot ship quietly.

import { createClient, MAX_LOG_SPAN, RpcError } from "../src/rpc.mjs";
import { ADDRESSES, DEFAULT_RULES, PACIFIC } from "../src/rules.mjs";
import { readTokenIdentity, TRANSFER_TOPIC } from "../src/metrics.mjs";
import { eventTopicOf } from "../src/keccak.mjs";

const client = createClient();
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

async function main() {
  // 1. The network is the network we think it is.
  const chainId = await client.chainId();
  check("chainId is 1672 (Pacific)", chainId === PACIFIC.chainId, `got ${chainId}`);

  // 2. Every address a rule points at exists as code on this chain.
  for (const [label, address] of Object.entries(ADDRESSES)) {
    try {
      const code = await client.code(address);
      check(`${label} has code`, code !== "0x" && code !== "0x0", code === "0x" ? "no code at address" : `${(code.length - 2) / 2} bytes`);
    } catch (err) {
      check(`${label} has code`, false, err.message);
    }
  }

  // 3. USDC is actually USDC. A rule named "USDC" pointing at a token with a
  //    different symbol would still evaluate happily and alert on nonsense.
  try {
    const id = await readTokenIdentity(client, { address: ADDRESSES.usdc });
    check("USDC symbol()", id.symbol === "USDC", `got ${JSON.stringify(id.symbol)}`);
    check("USDC decimals()", id.decimals === 6, `got ${id.decimals}`);
  } catch (err) {
    check("USDC identity", false, err.message);
  }

  // 4. The treasury rule watches an address that holds value. A zero balance
  //    would make the threshold meaningless.
  const bal = await client.balance(ADDRESSES.entryPointV07);
  check("EntryPoint v0.7 holds PROS", bal > 0n, `${bal} wei`);

  // 5. The event topic is derived, and the derived value is what the chain
  //    actually returns for a real Transfer log.
  const head = await client.blockNumber();
  const logs = await client.getLogs({
    address: ADDRESSES.usdc,
    topics: [TRANSFER_TOPIC],
    fromBlock: head - 200,
    toBlock: head,
  });
  const realTopic = logs[0]?.topics?.[0]?.toLowerCase();
  check("Transfer topic matches live logs", logs.length > 0 && realTopic === eventTopicOf("Transfer(address,address,uint256)").toLowerCase(), `${logs.length} logs, topic ${realTopic ?? "none"}`);

  // 6. The documented "1,000 block" cap is inclusive: 1,000 blocks pass, 1,001
  //    do not. Both bounds are asserted, because a one-sided check would have
  //    hidden the "latest" drift that made 1,000 look forbidden.
  const headHex = "0x" + head.toString(16);
  const atLimit = await expectResult(() =>
    client.rpc("eth_getLogs", [{ fromBlock: "0x" + (head - MAX_LOG_SPAN).toString(16), toBlock: headHex, address: ADDRESSES.usdc, topics: [TRANSFER_TOPIC] }]),
  );
  check(`getLogs accepts ${MAX_LOG_SPAN + 1} blocks (explicit toBlock)`, atLimit.ok, atLimit.ok ? `${atLimit.value.length} logs` : atLimit.message.slice(0, 80));

  const overLimit = await expectResult(() =>
    client.rpc("eth_getLogs", [{ fromBlock: "0x" + (head - MAX_LOG_SPAN - 1).toString(16), toBlock: headHex, address: ADDRESSES.usdc, topics: [TRANSFER_TOPIC] }]),
  );
  check(`getLogs rejects ${MAX_LOG_SPAN + 2} blocks (explicit toBlock)`, !overLimit.ok, overLimit.ok ? "node accepted a range it used to reject — revisit MAX_LOG_SPAN" : overLimit.message.slice(0, 60));

  // 7. Every rule names a metric the evaluator implements.
  const { evaluate } = await import("../src/rules.mjs");
  const evaluation = await evaluate(client, DEFAULT_RULES, { fromBlock: head - 20, toBlock: head });
  const unknownMetric = evaluation.results.filter((r) => r.state === "ERROR" && r.error?.kind === "config");
  check("all rules have readers", unknownMetric.length === 0, unknownMetric.map((r) => r.ruleId).join(", ") || "ok");
  check("evaluation completes", evaluation.counts.error < evaluation.results.length, `${evaluation.counts.ok} ok, ${evaluation.counts.triggered} triggered, ${evaluation.counts.error} error`);

  report();
}

async function expectResult(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, message: err instanceof RpcError ? err.message : String(err) };
  }
}

function report() {
  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) {
    const mark = c.ok ? "ok  " : "FAIL";
    console.log(`${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed. The rules or the chain changed; fix before shipping.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`fatal: ${err?.message || err}`);
  process.exit(2);
});
