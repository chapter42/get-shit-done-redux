'use strict';

// Tests for scripts/lint-regression-test-names.cjs — the identity ratchet
// that bans NEW top-level bug-NNNN test files (2026-06 CI audit). Uses the
// script's env overrides to point at sandbox fixture dirs; never touches the
// real tests/ directory or allowlist.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createTempDir, cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'lint-regression-test-names.cjs');

let sandbox;

let fixtureCount = 0;

function runLint({ files, allowlist }) {
  const testsDir = path.join(sandbox, `tests-${fixtureCount++}`);
  fs.mkdirSync(testsDir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(testsDir, f), '');
  const allowlistPath = path.join(testsDir, 'allowlist.json');
  fs.writeFileSync(allowlistPath, JSON.stringify(allowlist));
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      GSD_LINT_REGRESSION_TESTS_DIR: testsDir,
      GSD_LINT_REGRESSION_ALLOWLIST: allowlistPath,
    },
  });
}

describe('lint-regression-test-names', () => {
  before(() => {
    sandbox = createTempDir('gsd-lint-regression-');
  });

  after(() => {
    cleanup(sandbox);
  });

  test('passes when every bug-* file is grandfathered', () => {
    const r = runLint({
      files: ['bug-100-old.test.cjs', 'module.test.cjs'],
      allowlist: ['bug-100-old.test.cjs'],
    });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  });

  test('fails on a novel bug-* file with fold-into-module guidance', () => {
    const r = runLint({
      files: ['bug-100-old.test.cjs', 'bug-200-new.test.cjs'],
      allowlist: ['bug-100-old.test.cjs'],
    });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /bug-200-new\.test\.cjs/);
    assert.match(r.stderr, /owning module/);
  });

  test('fails on a stale allowlist entry (ratchet-down enforcement)', () => {
    const r = runLint({
      files: ['bug-100-old.test.cjs'],
      allowlist: ['bug-100-old.test.cjs', 'bug-300-gone.test.cjs'],
    });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /bug-300-gone\.test\.cjs/);
  });

  test('ignores non-bug test files and suite-marked non-bug names', () => {
    const r = runLint({
      files: ['module.test.cjs', 'feature.integration.test.cjs', 'debug-1-not-a-bug.test.cjs'],
      allowlist: [],
    });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  });

  test('catches a suite-marked bug-* file too (no marker escape hatch)', () => {
    const r = runLint({
      files: ['bug-400-sneaky.security.test.cjs'],
      allowlist: [],
    });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /bug-400-sneaky\.security\.test\.cjs/);
  });

  test('repo baseline passes (real tests/ dir against real allowlist)', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  });
});
