/**
 * Regression test for #1477: Claude Code global install ships no commands/gsd
 * source and never writes the .gsd-source marker, so /gsd-surface is fully
 * non-functional (list/status throw at findInstallSourceRoot, and the write
 * subcommands throw MODULE_NOT_FOUND at loadInstallExports).
 *
 * Repro (deployed Claude global layout):
 *   ~/.claude/gsd-core/{bin,contexts,references,templates,workflows}  — no commands/gsd
 *   ~/.claude/.gsd-source                                             — never written
 *   ~/.claude/bin/install.js                                          — never shipped
 *
 *   findInstallSourceRoot walks up from gsd-core/bin/lib looking for
 *   commands/gsd, finds nothing, and throws — killing list/status. The marker
 *   step that PR #1476 added (read side) never fires because nothing writes the
 *   marker (this issue is the write side). loadInstallExports' relative
 *   '../../../bin/install.js' resolves to ~/.claude/bin/install.js, which does
 *   not exist — killing profile/disable/enable/reset.
 *
 * Fix contract (both halves required):
 *   1. bin/install.js writes <configDir>/.gsd-source pointing at a resolvable
 *      commands/gsd source whose package root also holds bin/install.js.
 *   2. runtime-artifact-layout.cjs derives bin/install.js from that resolved
 *      source root, so install-exports load in the deployed layout too.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const { install } = require('../bin/install.js');
const { createTempDir, cleanup } = require('./helpers.cjs');

// The repo-resident module — exercised directly for the adversarial marker-reader
// cases (its walk-up always finds the repo commands/gsd, so marker precedence and
// fall-through can be asserted without a full install).
const {
  findInstallSourceRoot,
} = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');

function silenceConsole(fn) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
}

describe('bug #1477: .gsd-source marker provisioning + deployed install-exports resolution', () => {
  let tmpRoot;
  let savedHome;
  let savedUserProfile;
  let savedExplicitConfigDir;

  beforeEach(() => {
    tmpRoot = createTempDir('gsd-1477-');
    savedHome = process.env.HOME;
    // os.homedir() reads USERPROFILE on win32, HOME elsewhere; redirect both so
    // install() targets the fixture regardless of platform.
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpRoot;
    process.env.USERPROFILE = tmpRoot;
    savedExplicitConfigDir = process.env.GSD_EXPLICIT_CONFIG_DIR;
    delete process.env.GSD_EXPLICIT_CONFIG_DIR;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (savedExplicitConfigDir === undefined) delete process.env.GSD_EXPLICIT_CONFIG_DIR;
    else process.env.GSD_EXPLICIT_CONFIG_DIR = savedExplicitConfigDir;
    cleanup(tmpRoot);
  });

  // Guard against process.exit killing the runner mid-install.
  function runInstall(isGlobal, runtime) {
    const origExit = process.exit;
    let exitCalled = false;
    process.exit = (code) => {
      exitCalled = true;
      throw new Error(`process.exit(${code}) during install — should not happen`);
    };
    try {
      return silenceConsole(() => install(isGlobal, runtime));
    } catch (e) {
      if (exitCalled) assert.fail(`install() called process.exit — unexpected: ${e.message}`);
      throw e;
    } finally {
      process.exit = origExit;
    }
  }

  // ── Failure 1: the installer provisions a valid marker ──────────────────────
  test('global claude install writes a .gsd-source marker pointing at a real commands/gsd', () => {
    const claudeDir = path.join(tmpRoot, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    runInstall(true /* isGlobal */, 'claude');

    const markerPath = path.join(claudeDir, '.gsd-source');
    assert.ok(fs.existsSync(markerPath), `.gsd-source marker must be written at ${markerPath}`);

    const markerSrc = fs.readFileSync(markerPath, 'utf8').trim();
    assert.ok(path.isAbsolute(markerSrc), `marker must contain an absolute path, got: ${markerSrc}`);
    assert.ok(fs.existsSync(markerSrc), `marker target must exist on disk: ${markerSrc}`);
    assert.equal(
      path.basename(markerSrc), 'gsd',
      'marker must point at a commands/gsd directory',
    );
    assert.equal(path.basename(path.dirname(markerSrc)), 'commands');

    // The package root that holds commands/gsd must also hold bin/install.js —
    // this is what loadInstallExports derives the installer exports from.
    const derivedInstallJs = path.resolve(markerSrc, '..', '..', 'bin', 'install.js');
    assert.ok(
      fs.existsSync(derivedInstallJs),
      `bin/install.js must be reachable from the marker's package root: ${derivedInstallJs}`,
    );
  });

  // ── Failures 1+2 end-to-end: resolution succeeds FROM the deployed tree ──────
  // The deployed module's __dirname is <claudeDir>/gsd-core/bin/lib, which has no
  // commands/gsd ancestor (global skills layout). Only the marker rescues it.
  test('deployed global layout resolves source root + install-exports via the marker', () => {
    const claudeDir = path.join(tmpRoot, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    runInstall(true /* isGlobal */, 'claude');

    // Sanity: the global layout genuinely ships no commands/gsd source tree.
    assert.ok(
      !fs.existsSync(path.join(claudeDir, 'commands', 'gsd')),
      'precondition: global claude install must not ship commands/gsd',
    );

    const deployedLayoutPath = path.join(claudeDir, 'gsd-core', 'bin', 'lib', 'runtime-artifact-layout.cjs');
    assert.ok(fs.existsSync(deployedLayoutPath), 'deployed runtime-artifact-layout.cjs must exist');
    delete require.cache[deployedLayoutPath];
    const deployed = require(deployedLayoutPath);

    // Negative proof that the bug condition exists: WITHOUT consulting the marker
    // (no configDir argument), walk-up from the deployed tree has nothing to find.
    assert.throws(
      () => deployed.findInstallSourceRoot(),
      /could not locate commands\/gsd/,
      'deployed walk-up must fail without the marker — this is the regression condition',
    );

    // With the marker (configDir provided), list/status resolution succeeds.
    let resolved;
    assert.doesNotThrow(() => {
      resolved = deployed.findInstallSourceRoot(claudeDir);
    }, 'findInstallSourceRoot must resolve via the .gsd-source marker');
    assert.equal(path.basename(resolved), 'gsd');
    assert.ok(fs.existsSync(resolved));

    // The write-subcommand path: install-exports must load in the deployed layout.
    const exportsObj = deployed.getInstallExports(claudeDir);
    assert.equal(typeof exportsObj.computePathPrefix, 'function',
      'getInstallExports must expose computePathPrefix (used by applySurface)');
    assert.equal(typeof exportsObj.applyRuntimeContentRewritesInPlace, 'function',
      'getInstallExports must expose applyRuntimeContentRewritesInPlace (used by applySurface)');
  });

  // ── Adversarial marker-reader cases (no full install needed) ─────────────────
  describe('findInstallSourceRoot marker handling', () => {
    let cfgDir;
    beforeEach(() => { cfgDir = createTempDir('gsd-1477-marker-'); });
    afterEach(() => { cleanup(cfgDir); });

    test('marker pointing at a valid commands/gsd takes precedence over walk-up', () => {
      const fakeSrc = path.join(cfgDir, 'pkg', 'commands', 'gsd');
      fs.mkdirSync(fakeSrc, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, '.gsd-source'), fakeSrc + '\n', 'utf8');

      const resolved = findInstallSourceRoot(cfgDir);
      assert.equal(path.resolve(resolved), path.resolve(fakeSrc),
        'marker target must win over the repo walk-up');
    });

    test('marker pointing at a non-existent path is ignored (falls through to walk-up)', () => {
      const ghost = path.join(cfgDir, 'does', 'not', 'exist', 'commands', 'gsd');
      fs.writeFileSync(path.join(cfgDir, '.gsd-source'), ghost + '\n', 'utf8');

      // In-repo walk-up still resolves the real commands/gsd — no throw, and it is
      // NOT the dangling marker target.
      const resolved = findInstallSourceRoot(cfgDir);
      assert.notEqual(path.resolve(resolved), path.resolve(ghost));
      assert.equal(path.resolve(resolved), path.resolve(REPO_ROOT, 'commands', 'gsd'));
    });

    test('empty / whitespace-only marker is ignored', () => {
      fs.writeFileSync(path.join(cfgDir, '.gsd-source'), '   \n', 'utf8');
      const resolved = findInstallSourceRoot(cfgDir);
      assert.equal(path.resolve(resolved), path.resolve(REPO_ROOT, 'commands', 'gsd'));
    });
  });
});
