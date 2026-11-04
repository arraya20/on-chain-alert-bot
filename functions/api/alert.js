// GET /api/alert?window=60      → live evaluation over the last N blocks
//
// Rule metadata lives at /api/rules (functions/api/rules.js) so the two routes
// do not share one file: a Pages Function file maps to exactly one path, and a
// pathname check inside this handler would never be reached.
//
// There is deliberately no endpoint that dispatches. A public URL that sends
// Telegram messages is a spam cannon; delivery belongs to the watcher, which
// runs with the deployment's own credentials.
//
// Failure policy: if the chain cannot be read, respond 502 with the upstream
// error and NO results. Partial or invented data on a monitoring dashboard is
// worse than an error page.

import { createClient, describeError } from "../../src/rpc.mjs";
import { evaluate, DEFAULT_RULES, PACIFIC } from "../../src/rules.mjs";

const MAX_WINDOW = 999; // inclusive block span the node accepts
const DEFAULT_WINDOW = 60;

const json = (body, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  // Validate before spending anything.
  const windowParam = url.searchParams.get("window");
  let window = DEFAULT_WINDOW;
  if (windowParam !== null) {
    if (!/^\d+$/.test(windowParam)) {
      return json({ error: { kind: "bad_request", message: "window must be a positive integer" } }, 400);
    }
    window = Number(windowParam);
    if (window < 1 || window > MAX_WINDOW) {
      return json({ error: { kind: "bad_request", message: `window must be between 1 and ${MAX_WINDOW} (the node rejects wider log ranges)` } }, 400);
    }
  }

  const rpcUrl = env?.PHAROS_RPC_URL || PACIFIC.rpc;
  const client = createClient({ url: rpcUrl, timeoutMs: 15_000 });

  let head;
  try {
    head = await client.blockNumber();
  } catch (err) {
    const e = describeError(err);
    return json({ error: { ...e, stage: "head" }, network: PACIFIC }, 502);
  }

  const fromBlock = Math.max(0, head - (window - 1));

  let evaluation;
  try {
    evaluation = await evaluate(client, DEFAULT_RULES, { fromBlock, toBlock: head });
  } catch (err) {
    const e = describeError(err);
    return json({ error: { ...e, stage: "evaluate" }, network: PACIFIC, head }, 502);
  }

  if (evaluation.counts.ok === 0 && evaluation.counts.error === evaluation.results.length) {
    // Every rule failed to measure. That is an outage, not a quiet chain.
    return json({ error: { kind: "upstream", message: "no rule could be measured", stage: "evaluate" }, network: PACIFIC, head }, 502);
  }

  return json({
    network: PACIFIC,
    head,
    window,
    ...evaluation,
  });
}

export async function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  return json({ error: { kind: "method_not_allowed", message: "GET only; delivery runs in the watcher, not over HTTP" } }, 405, { allow: "GET" });
}
