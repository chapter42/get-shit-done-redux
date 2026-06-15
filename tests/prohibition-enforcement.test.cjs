// allow-test-rule: runtime-contract-is-the-product (#1259) — the test-tier enforcement PRODUCER is
// the deployed verify-time gate; these assertions pin its deterministic locate/fail-first/run/
// evidence-construction contract to the code (ADR-550 D5d).
//
// Behavioral tests for the deterministic prohibition-enforcement producer (#1259, ADR-550 D5d
// "heavy half"). Requires the BUILT gsd-core/bin/lib/prohibition-enforcement.cjs — authored as
// src/prohibition-enforcement.cts and compiled by `npm run build:lib` (mirrors how the verify-tier
// suite requires the built probe-core.cjs). Typed-field assertions only; the check-runner is
// injected so no real subprocess is spawned. No source-grep.
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');

const ENFORCEMENT_LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'prohibition-enforcement.cjs');

const TEST_TIER = Object.freeze({
  requirement_id: 'R1',
  category: 'safety',
  status: 'resolved',
  verification: 'test',
  resolution: null,
  reason: null,
  statement: 'MUST NOT read source files and text-search them in tests',
});

describe('prohibition-enforcement: deterministic test-tier producer (#1259 / ADR-550 D5d)', () => {
  test('exports the producer + route functions', () => {
    const enforce = require(ENFORCEMENT_LIB);
    assert.equal(typeof enforce.runProhibitionEnforcement, 'function',
      'must export runProhibitionEnforcement (the deterministic producer)');
    assert.equal(typeof enforce.routeProhibitionEnforcement, 'function',
      'must export routeProhibitionEnforcement (the CLI surface)');
  });

  test('locate-miss (no check descriptor) -> fail-closed, located:false, no evidence', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(TEST_TIER, null, {
      runCheck: () => ({ failFirst: true, passed: true }),
    });
    assert.equal(result.located, false, 'no locatable check');
    assert.notEqual(result.status, 'green', 'locate-miss must never be green');
    assert.equal(result.flagged, true, 'locate-miss must be flagged');
    assert.equal(result.kind, null, 'no kind when nothing located');
    assert.ok(Array.isArray(result.evidence) && result.evidence.length === 0, 'no evidence on locate-miss');
  });

  test('malformed check descriptor (missing target) -> treated as locate-miss', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(TEST_TIER, { kind: 'node-test' }, {
      runCheck: () => ({ failFirst: true, passed: true }),
    });
    assert.equal(result.located, false, 'a descriptor without a target is not locatable');
    assert.notEqual(result.status, 'green');
    assert.equal(result.flagged, true);
  });

  test('node-test check that passes -> green + non-empty typed evidence', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
      { runCheck: () => ({ failFirst: true, passed: true }) },
    );
    assert.equal(result.status, 'green');
    assert.equal(result.flagged, false);
    assert.equal(result.tier, 'test');
    assert.equal(result.located, true);
    assert.equal(result.kind, 'node-test');
    assert.equal(result.evidence.length, 1, 'one evidence record built');
    const ev = result.evidence[0];
    assert.equal(ev.kind, 'node-test');
    assert.equal(ev.target, 'tests/neg.test.cjs');
    assert.equal(ev.failFirst, true);
    assert.equal(ev.passed, true);
  });

  test('lint-rule (no-source-grep) check that passes -> green, evidence carries rule id', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'lint-rule', rule: 'local/no-source-grep', target: 'tests/', failFirst: true },
      { runCheck: () => ({ failFirst: true, passed: true }) },
    );
    assert.equal(result.status, 'green');
    assert.equal(result.flagged, false);
    assert.equal(result.kind, 'lint-rule');
    assert.equal(result.evidence[0].kind, 'lint-rule');
    assert.equal(result.evidence[0].rule, 'local/no-source-grep', 'evidence records which rule asserted the must-NOT');
    assert.equal(result.evidence[0].target, 'tests/', 'evidence records the linted target path, not the rule id');
  });

  test('buildLintArgs maps the rule id and lint target to DISTINCT eslint args (#1259 runner fix)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    assert.equal(typeof enforce.buildLintArgs, 'function',
      'must export buildLintArgs — the pure argv mapper for the lint-rule real runner');
    const argv = enforce.buildLintArgs({ kind: 'lint-rule', rule: 'local/no-source-grep', target: 'tests/' });
    assert.ok(Array.isArray(argv), 'argv is an array');
    const ruleIdx = argv.indexOf('--rule');
    assert.ok(ruleIdx !== -1, 'forces a specific rule via --rule');
    assert.equal(argv[ruleIdx + 1], 'local/no-source-grep: error', 'the rule id is forced to error');
    assert.equal(argv[argv.length - 1], 'tests/', 'the LAST arg is the lint target path');
    assert.notEqual(argv[ruleIdx + 1], argv[argv.length - 1],
      'the rule id must NOT be reused as the lint target (the bug this guards)');
  });

  test('lint-rule descriptor missing its rule id -> locate-miss, never green', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'lint-rule', target: 'tests/', failFirst: true }, // no `rule`
      { runCheck: () => ({ failFirst: true, passed: true }) },
    );
    assert.notEqual(result.status, 'green', 'a lint-rule with no rule id is not a valid wired check');
    assert.equal(result.flagged, true);
    assert.equal(result.located, false, 'an under-specified lint-rule descriptor is not locatable');
  });

  test('check that FAILS -> hard-gate (non-green, flagged), located:true, no evidence', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
      { runCheck: () => ({ failFirst: true, passed: false }) },
    );
    assert.notEqual(result.status, 'green');
    assert.equal(result.flagged, true);
    assert.equal(result.located, true, 'the check was located even though it failed');
    assert.equal(result.evidence.length, 0, 'a failing check builds no evidence');
  });

  test('fail-first NOT satisfied (descriptor or runner) -> hard-gate, never green', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // descriptor declares failFirst:false
    const a = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: false },
      { runCheck: () => ({ failFirst: false, passed: true }) },
    );
    assert.notEqual(a.status, 'green', 'not-fail-first is not a valid regression proof');
    assert.equal(a.flagged, true);
    // descriptor says failFirst:true but runner reports failFirst:false -> still hard-gate
    const b = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
      { runCheck: () => ({ failFirst: false, passed: true }) },
    );
    assert.notEqual(b.status, 'green', 'runner-reported not-fail-first must also hard-gate');
    assert.equal(b.flagged, true);
  });

  test('hard-gates in BOTH modes on a failing check (ADR-550 D4)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    for (const mode of ['interactive', 'autonomous']) {
      const result = enforce.runProhibitionEnforcement(
        TEST_TIER,
        { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
        { runCheck: () => ({ failFirst: true, passed: false }), mode },
      );
      assert.notEqual(result.status, 'green', `non-green in ${mode}`);
      assert.equal(result.flagged, true, `flagged in ${mode}`);
      assert.equal(result.mode, mode, 'mode echoed for transparency');
    }
  });

  test('passing run echoes the requested mode without changing the green verdict', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
      { runCheck: () => ({ failFirst: true, passed: true }), mode: 'autonomous' },
    );
    assert.equal(result.status, 'green', 'a passing wired check is green in autonomous mode too');
    assert.equal(result.mode, 'autonomous');
  });

  test('routeProhibitionEnforcement parses a JSON request file and emits a structured result', (t) => {
    const fs = require('node:fs');
    const { execFileSync } = require('node:child_process');
    // Write a request file; the route reads it and runs the node-test descriptor's default runner
    // (its target does not exist, so it fail-closes deterministically — we assert the JSON SHAPE,
    // not a green verdict). We invoke the built CLI surface in a child process so output()
    // (writeAllSync to fd 1) is captured on stdout — no source-grep (we parse our own emitted JSON).
    const dir = createTempDir('prohib-enf-');
    const reqPath = path.join(dir, 'req.json');
    const runnerPath = path.join(dir, 'runner.cjs');
    fs.writeFileSync(reqPath, JSON.stringify({
      prohibition: TEST_TIER,
      check: { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
      mode: 'autonomous',
    }));
    // A tiny runner that requires the BUILT module and invokes the route — output() writes to fd 1.
    fs.writeFileSync(runnerPath,
      "require(" + JSON.stringify(ENFORCEMENT_LIB) + ")" +
      ".routeProhibitionEnforcement(['check','prohibition-enforcement'," + JSON.stringify(reqPath) + "], false);\n");
    t.after(() => cleanup(dir));

    const captured = execFileSync('node', [runnerPath], { encoding: 'utf-8' });
    const parsed = JSON.parse(captured);
    assert.equal(typeof parsed, 'object', 'route emits a JSON object');
    assert.equal(parsed.tier, 'test', 'tier is preserved through the CLI surface');
    assert.equal(parsed.located, true, 'the check descriptor was located');
    assert.equal(parsed.mode, 'autonomous', 'mode flows through the CLI surface');
    assert.equal(typeof parsed.flagged, 'boolean', 'flagged is a typed boolean');
    assert.ok(Array.isArray(parsed.evidence), 'evidence is an array');
  });
});
