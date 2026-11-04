// Superseded and no longer imported.
//
// This file belonged to the original scaffold. It evaluated rules against their
// own thresholds when no telemetry was supplied, which made every ">=" rule
// report TRIGGERED on data that was never read, and it returned
// { status: "DELIVERED" } from a function that never made a network call.
//
// The behaviour now lives in:
//   src/rpc.mjs      JSON-RPC client with typed failures
//   src/metrics.mjs  readers that measure or throw
//   src/rules.mjs    rule definitions and evaluation
//   src/dispatch.mjs delivery that only says "sent" after a 2xx
//
// Kept as a marker instead of being deleted because this checkout has no git
// history to recover from. Safe to remove.
export {};
