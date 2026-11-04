// GET /api/rules — the rule table as the server defines it.
//
// No chain access, so this answers instantly and stays cacheable. The dashboard
// does not need it (the evaluation payload carries everything it renders), but
// an agent reading this deployment benefits from a machine-readable contract
// that does not require synthesising a fake evaluation to discover.

import { DEFAULT_RULES, PACIFIC } from "../../src/rules.mjs";

const FIELDS = ["id", "name", "severity", "metric", "target", "comparator", "threshold", "unit", "decimals", "channel", "why"];

export async function onRequestGet() {
  const rules = DEFAULT_RULES.map((rule) => Object.fromEntries(FIELDS.filter((f) => rule[f] !== undefined).map((f) => [f, rule[f]])));
  return new Response(JSON.stringify({ network: PACIFIC, ruleCount: rules.length, rules }, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

export async function onRequest({ request }) {
  if (request.method === "GET") return onRequestGet();
  return new Response(JSON.stringify({ error: { kind: "method_not_allowed", message: "GET only" } }), {
    status: 405,
    headers: { "content-type": "application/json; charset=utf-8", allow: "GET" },
  });
}
