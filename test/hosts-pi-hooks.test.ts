import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPiHooks, piHookTargets } from '../src/hosts/pi-hooks.js';
import { piCapabilities } from '../src/hosts/pi-capabilities.js';
import { runHostsInit } from '../src/hosts/init.js';
import { editedFilePath } from '../src/claude/hooks.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-pihooks-')); }

const HAS_EXEC_BIT = process.platform !== 'win32';
function assertRunnableShim(shim: string, note: string): void {
  assert.ok(existsSync(shim), `${note}: shim missing at ${shim}`);
  if (HAS_EXEC_BIT) assert.ok(statSync(shim).mode & 0o111, note);
}

const shimPath = (repo: string) => join(repo, '.pi', 'hooks', 'graft-hooks.cjs');
const settingsPath = (repo: string) => join(repo, '.pi', 'settings.json');
const readHooks = (repo: string) => JSON.parse(readFileSync(settingsPath(repo), 'utf8')).hooks;

test('piHookTargets are repo-local and always present (no CLI-home gate)', () => {
  const repo = fresh();
  const t = piHookTargets(repo);
  assert.equal(t.length, 2);
  assert.ok(t.every((w) => w.scope === 'repo' && w.hostId === 'pi' && w.kind === 'hook'));
  assert.deepEqual(t.map((w) => w.path).sort(), [settingsPath(repo), shimPath(repo)].sort());
});

test('writes shim + Claude-format hooks block in .pi/settings.json, idempotent on re-run', () => {
  const repo = fresh();
  const w = installPiHooks(repo);
  assert.deepEqual(w.map((x) => x.action), ['created', 'created']);
  assertRunnableShim(shimPath(repo), 'shim is executable');

  const hooks = readHooks(repo);
  // The four graft hooks as Claude-format entries a hook-runner extension
  // reads: command + timeout in *seconds* (the runner's convention).
  const cmd = (event: string) => hooks[event]?.flatMap((g: any) => g.hooks ?? []).map((h: any) => h.command);
  assert.deepEqual(cmd('SessionStart'), ['node ".pi/hooks/graft-hooks.cjs" session-start'], 'orientation hook');
  assert.deepEqual(cmd('UserPromptSubmit'), ['node ".pi/hooks/graft-hooks.cjs" prompt'], 'the coupling-seed retrieval hook');
  assert.deepEqual(cmd('PostToolUse'), ['node ".pi/hooks/graft-hooks.cjs" post-edit'], 'edit hook');
  assert.deepEqual(cmd('Stop'), ['node ".pi/hooks/graft-hooks.cjs" stop'], 'background-sync hook');
  // the matcher names Pi's native mutating tools
  assert.equal(hooks.PostToolUse[0].matcher, 'edit|write');
  // seconds, not the milliseconds graft passes to its own children
  assert.equal(hooks.UserPromptSubmit[0].hooks[0].timeout, 15);
  // a relative shim path: a committed settings.json carries no absolute path
  const settings = readFileSync(settingsPath(repo), 'utf8');
  assert.ok(!settings.includes(repo), 'no absolute install path baked into a committed file');

  const again = installPiHooks(repo);
  assert.deepEqual(again.map((x) => x.action), ['unchanged', 'unchanged'], 'idempotent');
});

test("foreign settings keys and foreign hook entries are preserved", () => {
  const repo = fresh();
  mkdirSync(join(repo, '.pi'), { recursive: true });
  writeFileSync(settingsPath(repo), JSON.stringify({
    packages: ['npm:@hsingjui/pi-hooks'],
    shellPath: 'C:/Program Files/Git/bin/bash.exe',
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'their-hook.sh' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'their-stop.sh' }] }],
    },
  }, null, 2));

  installPiHooks(repo);
  const root = JSON.parse(readFileSync(settingsPath(repo), 'utf8'));
  assert.deepEqual(root.packages, ['npm:@hsingjui/pi-hooks'], 'packages untouched');
  assert.equal(root.shellPath, 'C:/Program Files/Git/bin/bash.exe', 'foreign keys untouched');
  const starts = root.hooks.SessionStart.map((g: any) => g.hooks[0].command);
  assert.deepEqual(starts, ['their-hook.sh', 'node ".pi/hooks/graft-hooks.cjs" session-start'], 'foreign entry kept, graft appended');
  const stops = root.hooks.Stop.map((g: any) => g.hooks[0].command);
  assert.deepEqual(stops, ['their-stop.sh', 'node ".pi/hooks/graft-hooks.cjs" stop']);

  // Re-running replaces graft's entry rather than stacking a second copy.
  installPiHooks(repo);
  const again = readHooks(repo);
  assert.equal(again.SessionStart.length, 2, 'still one graft entry');
});

test('an unparseable settings.json is left alone (shim still written)', () => {
  const repo = fresh();
  mkdirSync(join(repo, '.pi'), { recursive: true });
  writeFileSync(settingsPath(repo), '{ not json');
  const w = installPiHooks(repo);
  assert.ok(w.some((x) => x.id === 'pi-hooks' && x.action === 'skipped-unparseable'));
  assert.equal(readFileSync(settingsPath(repo), 'utf8'), '{ not json');
  assertRunnableShim(shimPath(repo), 'shim still installed');
});

test('editedFilePath reads the touched file from Pi\'s edit shape', () => {
  const dir = '/repo';
  // Pi's edit/write tools name the file `path`, absolute or repo-relative.
  assert.equal(editedFilePath({ tool_input: { path: '/repo/src/a.ts' } }, dir), '/repo/src/a.ts');
  assert.equal(editedFilePath({ tool_input: { path: 'src/b.ts' } }, dir), join(dir, 'src/b.ts'));
  // Claude's shape still wins when both are present, and nothing → null.
  assert.equal(
    editedFilePath({ tool_input: { file_path: '/repo/c.ts', path: 'd.ts' } }, dir),
    '/repo/c.ts',
  );
  assert.equal(editedFilePath({ tool_input: { path: '  ' } }, dir), null);
});

// ── capability probe ────────────────────────────────────────────────────────

test('piCapabilities reports nothing installed on a bare machine', () => {
  const repo = fresh(); const home = fresh();
  assert.deepEqual(piCapabilities(repo, home), { mcp: null, hooks: null });
});

test('piCapabilities finds packages in project and user settings', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  writeFileSync(join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({ packages: ['npm:pi-mcp-extension'] }));
  mkdirSync(join(repo, '.pi'), { recursive: true });
  writeFileSync(settingsPath(repo), JSON.stringify({ packages: ['npm:@hsingjui/pi-hooks'] }));
  assert.deepEqual(piCapabilities(repo, home), { mcp: 'pi-mcp-extension', hooks: '@hsingjui/pi-hooks' });
});

test('piCapabilities finds installed packages under .pi/npm/node_modules', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(repo, '.pi', 'npm', 'node_modules', '@hsingjui', 'pi-hooks'), { recursive: true });
  assert.equal(piCapabilities(repo, home).hooks, '@hsingjui/pi-hooks');
  // the unrelated `pi-hooks` collection is NOT a Claude-format hook runner
  mkdirSync(join(repo, '.pi', 'npm', 'node_modules', 'pi-hooks'), { recursive: true });
  assert.equal(piCapabilities(repo, home).hooks, '@hsingjui/pi-hooks', 'bare pi-hooks is not a runner');
});

// ── runHostsInit wiring ─────────────────────────────────────────────────────

test('runHostsInit --agents pi writes the repo-local hook files and never touches ~/.pi', () => {
  const home = fresh(); const repo = fresh();
  const r = runHostsInit(repo, { home, agents: ['pi'] });
  assert.ok(existsSync(settingsPath(repo)), 'hook entries written in the repo settings');
  assertRunnableShim(shimPath(repo), 'shim written in the repo');
  assert.ok(r.hooks.some((h) => h.id === 'pi-hooks'), 'reported in result.hooks');
  assert.ok(!existsSync(join(home, '.pi')), 'no ~/.pi writes');
});

test('pi hooks are repo-local, so --no-global does NOT suppress them', () => {
  const home = fresh(); const repo = fresh();
  runHostsInit(repo, { home, agents: ['pi'], global: false });
  assert.ok(existsSync(settingsPath(repo)), '--no-global keeps the repo-local hook entries');
});

test('--no-hooks skips the Pi hook files (skill still written)', () => {
  const home = fresh(); const repo = fresh();
  const r = runHostsInit(repo, { home, agents: ['pi'], hooks: false });
  assert.ok(!existsSync(settingsPath(repo)), 'no settings.json under --no-hooks');
  assert.ok(!existsSync(shimPath(repo)), 'no shim under --no-hooks');
  assert.ok(!r.hooks.some((h) => h.id?.startsWith('pi')), 'no pi hook writes reported');
  assert.ok(existsSync(join(repo, '.pi', 'skills', 'graft', 'SKILL.md')), 'the skill is still written');
});
