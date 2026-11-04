#!/usr/bin/env node
// Sends one alert-shaped message to every channel that is configured, and
// prints what the provider actually answered.
//
//   node scripts/test-delivery.mjs
//
// Exit codes: 0 all configured channels accepted, 1 at least one failed,
// 2 nothing was configured (so a CI run cannot pass by sending nothing).

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { dispatch, channelConfig } from "../src/dispatch.mjs";
import { payloadFor } from "../src/format.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const envPath = join(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const sample = {
  ruleId: "delivery-test",
  name: "Delivery test",
  state: "TRIGGERED",
  severity: "warning",
  target: null,
  comparator: ">=",
  thresholdFormatted: "1 test",
  observedFormatted: "1 test",
  why: "If you can read this, the channel is wired up. No chain condition was involved.",
  detail: null,
};

const channels = ["telegram", "discord", "slack", "webhook"];
const configured = channels.filter((c) => channelConfig(c) !== null);

if (configured.length === 0) {
  console.error("No channel is configured. Set one of:");
  console.error("  TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID");
  console.error("  DISCORD_WEBHOOK_URL");
  console.error("  SLACK_WEBHOOK_URL");
  console.error("  ALERT_WEBHOOK_URL");
  process.exit(2);
}

let failures = 0;
for (const channel of configured) {
  const payload = payloadFor(channel, sample);
  const result = await dispatch(channel, payload);
  const line = `${channel.padEnd(9)} ${result.status}${result.httpStatus ? " " + result.httpStatus : ""}${result.detail ? " — " + result.detail : ""}`;
  if (result.status === "sent") console.log("ok   " + line);
  else {
    failures += 1;
    console.log("FAIL " + line);
  }
}

console.log(`\n${configured.length - failures}/${configured.length} configured channels accepted the message`);
process.exit(failures > 0 ? 1 : 0);
