// Tiny test harness. No framework: the suite must run on a bare Node install
// with zero dependencies, because that is how it will be run in CI and by
// anyone checking the claims in the README.

const tests = [];
let current = null;

export function suite(name) {
  current = name;
}

export function test(name, fn) {
  tests.push({ suite: current, name, fn });
}

export function assert(cond, message) {
  if (!cond) throw new Error(message || "assertion failed");
}

// JSON.stringify throws on BigInt, and this suite compares BigInts constantly.
const shape = (v) => JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? `${val}n` : val));

export function equal(actual, expected, message) {
  const a = shape(actual);
  const e = shape(expected);
  if (a !== e) throw new Error(`${message || "not equal"}\n  actual:   ${a}\n  expected: ${e}`);
}

export async function rejects(fn, matcher) {
  try {
    await fn();
  } catch (err) {
    if (matcher && !matcher(err)) throw new Error(`threw, but not the expected error: ${err.message}`);
    return err;
  }
  throw new Error("expected the call to throw, and it returned");
}

export async function run() {
  let passed = 0;
  const failures = [];
  let lastSuite = null;

  for (const t of tests) {
    if (t.suite !== lastSuite) {
      console.log(`\n${t.suite}`);
      lastSuite = t.suite;
    }
    try {
      await t.fn();
      passed += 1;
      console.log(`  ok   ${t.name}`);
    } catch (err) {
      failures.push({ ...t, err });
      console.log(`  FAIL ${t.name}`);
      console.log(`       ${String(err.message).split("\n").join("\n       ")}`);
    }
  }

  console.log(`\n${passed} passed, ${failures.length} failed, ${tests.length} total`);
  if (failures.length > 0) process.exitCode = 1;
  return { passed, failures };
}
