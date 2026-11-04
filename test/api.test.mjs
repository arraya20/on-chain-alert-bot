// The Pages Function, exercised directly with a stubbed transport. No network,
// no wrangler: import the handler, call it with a Request, inspect the Response.
//
// The point of these tests is the failure paths. A dashboard that shows a
// verdict it could not measure is the exact behaviour this rewrite removed.

import { suite, test, assert, equal, run } from "./harness.mjs";

const { onRequest } = await import("../functions/api/alert.js");
const { onRequest: rulesEndpoint } = await import("../functions/api/rules.js");
const { ADDRESSES } = await import("../src/rules.mjs");
const { PAUSED_SELECTOR, SYMBOL_SELECTOR, DECIMALS_SELECTOR } = await import("../src/metrics.mjs");

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const encodedString = (s) => {
  const hex = Buffer.from(s, "utf8").toString("hex");
  return "0x" + word(32) + word(s.length) + hex.padEnd(64, "0");
};

// Canned node. `overrides` lets a test break one method without losing the rest.
function stubFetch({ failAll = false, overrides = {}, calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    if (failAll) {
      const err = new Error("fetch failed");
      err.cause = { code: "ECONNREFUSED" };
      throw err;
    }

    const { id, method, params } = JSON.parse(init.body);
    if (overrides[method]) {
      const value = overrides[method](params);
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, result: value }) };
    }

    let result;
    switch (method) {
      case "eth_blockNumber":
        result = "0x" + (1000).toString(16);
        break;
      case "eth_chainId":
        result = "0x688";
        break;
      case "eth_gasPrice":
        result = "0x2540be400";
        break;
      case "eth_getBalance":
        result = "0x" + word(10n ** 21n);
        break;
      case "eth_getCode":
        result = "0x6001600155";
        break;
      case "eth_getLogs":
        result = [];
        break;
      case "eth_getBlockByNumber":
        result = {
          number: params[0],
          timestamp: "0x" + (1_780_000_000).toString(16),
          gasUsed: "0x0",
          gasLimit: "0x1c9c380",
          baseFeePerGas: "0x2540be400",
          transactions: [],
        };
        break;
      case "eth_call": {
        const data = params[0].data;
        if (data === PAUSED_SELECTOR) result = "0x" + word(0);
        else if (data === SYMBOL_SELECTOR) result = encodedString("USDC");
        else if (data === DECIMALS_SELECTOR) result = "0x" + word(6);
        else result = "0x";
        break;
      }
      default:
        result = null;
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, result }) };
  };
}

async function call(url, { env = {}, method = "GET", fetchImpl } = {}) {
  const prev = globalThis.fetch;
  if (fetchImpl) globalThis.fetch = fetchImpl;
  try {
    const request = new Request(url, { method });
    const res = await onRequest({ request, env });
    const body = await res.json().catch(() => null);
    return { status: res.status, body, headers: res.headers };
  } finally {
    globalThis.fetch = prev;
  }
}

suite("api: a verdict is only shown when it was measured");
test("GET /api/alert returns five measured rules and the chain id", async () => {
  const calls = [];
  const { status, body } = await call("https://app.test/api/alert?window=1", { fetchImpl: stubFetch({ calls }) });
  equal(status, 200);
  equal(body.chainId, 1672);
  equal(body.results.length, 5);
  equal(body.counts.error, 0);
  equal(body.degraded, false);
  equal(body.blockRange.from, 1000);
  assert(body.head === 1000, `head was ${body.head}`);
});
test("window bounds are validated before any rpc call is made", async () => {
  const calls = [];
  const fetchImpl = stubFetch({ calls });
  for (const bad of ["0", "1000", "-5", "abc", "60.5"]) {
    const { status, body } = await call(`https://app.test/api/alert?window=${bad}`, { fetchImpl });
    equal(status, 400, `window=${bad} should be rejected`);
    equal(body.error.kind, "bad_request");
  }
  equal(calls.length, 0, "an invalid window must not reach the node");
});
test("the default window is 60 blocks and the cap is 999", async () => {
  const calls = [];
  const { status } = await call("https://app.test/api/alert", { fetchImpl: stubFetch({ calls }) });
  equal(status, 200);
  const logCall = calls.map((c) => JSON.parse(c.body)).find((b) => b.method === "eth_getLogs");
  const from = Number(BigInt(logCall.params[0].fromBlock));
  equal(from, 941, "60-block window ends at 1000, so it starts at 941");
});
test("a dead node is 502 with the error, and no results key at all", async () => {
  const { status, body } = await call("https://app.test/api/alert?window=1", { fetchImpl: stubFetch({ failAll: true }) });
  equal(status, 502);
  assert(body.error, "the error must be reported");
  equal("results" in body, false, "an outage must not ship a results array");
  equal(body.head, undefined);
});
test("if every rule fails to measure, the response is 502 rather than a quiet page", async () => {
  const fetchImpl = stubFetch({
    overrides: {
      eth_getBalance: () => { throw new Error("should not be reached"); },
    },
  });
  // Break the node by making every call return a shape the client rejects.
  const broken = async (url, init) => {
    const { id, method } = JSON.parse(init.body);
    if (method === "eth_blockNumber") return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, result: "0x3e8" }) };
    return { ok: false, status: 500, text: async () => "upstream down" };
  };
  const { status, body } = await call("https://app.test/api/alert?window=1", { fetchImpl: broken });
  equal(status, 502);
  assert(body.error, "an all-error evaluation must be an error response");
});
test("GET /api/rules is a separate route and needs no chain access", async () => {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = stubFetch({ calls });
  try {
    const res = await rulesEndpoint({ request: new Request("https://app.test/api/rules") });
    equal(res.status, 200);
    const body = await res.json();
    equal(body.rules.length, 5);
    equal(body.network.chainId, 1672);
    equal(calls.length, 0, "the rules endpoint must not touch the node");
  } finally {
    globalThis.fetch = prev;
  }
});
test("GET /api/rules refuses POST", async () => {
  const res = await rulesEndpoint({ request: new Request("https://app.test/api/rules", { method: "POST" }) });
  equal(res.status, 405);
});
// The scaffold's dashboard had an "evaluate and dispatch" path. A public URL
// that sends messages is a spam cannon, so the API must never deliver.
test("a GET never sends a message, even with credentials in the environment", async () => {
  const calls = [];
  const env = { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "1", DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/x" };
  const { status } = await call("https://app.test/api/alert?window=1", { env, fetchImpl: stubFetch({ calls }) });
  equal(status, 200);
  const leaked = calls.filter((c) => /telegram|discord|slack/i.test(c.url));
  equal(leaked, [], "the evaluation endpoint tried to deliver a message");
});
test("POST is refused: delivery belongs to the watcher", async () => {
  const { status, body } = await call("https://app.test/api/alert", { method: "POST", fetchImpl: stubFetch({}) });
  equal(status, 405);
  equal(body.error.kind, "method_not_allowed");
});
test("a rule that cannot be measured is reported as ERROR in the payload", async () => {
  // Make paused() revert: the token answers, but not with a bool.
  const fetchImpl = stubFetch({
    overrides: {
      eth_call: (params) => {
        if (params[0].data === PAUSED_SELECTOR) throw new Error("execution reverted");
        if (params[0].data === SYMBOL_SELECTOR) return encodedString("USDC");
        if (params[0].data === DECIMALS_SELECTOR) return "0x" + word(6);
        return "0x";
      },
    },
  });
  const { status, body } = await call("https://app.test/api/alert?window=1", { fetchImpl });
  equal(status, 200);
  const paused = body.results.find((r) => r.ruleId === "contract-paused");
  equal(paused.state, "ERROR");
  equal(body.degraded, true);
  assert(body.counts.ok >= 1, "the other rules should still have measured");
});

await run();
