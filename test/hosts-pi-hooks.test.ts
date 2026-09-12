import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPiHooks, piHookTargets, piExtension } from '../src/hosts/pi-hooks.js';
import { runHostsInit } from '../src/hosts/init.js';
import { editedFilePath } from '../src/claude/hooks.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-pihooks-')); }

const HAS_EXEC_BIT = process.platform !== 'win32';
function assertRunnableShim(shim: string, note: string): void {
  assert.ok(existsSync(shim), `${note}: shim missing at ${shim}`);
  if (HAS_EXEC_BIT) assert.ok(statSync(shim).mode & 0o111, note);
}

const shimPath = (repo: string) => join(repo, '.pi', 'hooks', 'graft-hooks.cjs');
const extPath = (repo: string) => join(repo, '.pi', 'extensions', 'graft.ts');

test('piHookTargets are repo-local and always present (no CLI-home gate)', () => {
  const repo = fresh();
  const t = piHookTargets(repo);
  assert.equal(t.length, 2);
  assert.ok(t.every((w) => w.scope === 'repo' && w.hostId === 'pi' && w.kind === 'hook'));
  assert.deepEqual(t.map((w) => w.path).sort(), [extPath(repo), shimPath(repo)].sort());
});

test('writes shim + extension, idempotent on re-run', () => {
  const repo = fresh();
  const w = installPiHooks(repo);
  assert.deepEqual(w.map((x) => x.action), ['created', 'created']);
  assertRunnableShim(shimPath(repo), 'shim is executable');

  const ext = readFileSync(extPath(repo), 'utf8');
  // Pi's hook system is the extension API, so the four graft hooks are `pi.on`
  // subscriptions rather than entries in a config file.
  const sub = (event: string) =>
    ext.match(new RegExp(`pi\\.on\\('${event}'[\\s\\S]*?runHook\\(\\s*'([a-z-]+)'`))?.[1];
  assert.equal(sub('session_start'), 'session-start', 'orientation hook');
  assert.equal(sub('before_agent_start'), 'prompt', 'the coupling-seed retrieval hook');
  assert.equal(sub('tool_result'), 'post-edit', 'edit hook');
  // agent_settled, not agent_end: Pi can auto-retry or run a queued message after
  // a run ends, and the sync belongs at the point it stops on its own.
  assert.equal(sub('agent_settled'), 'stop', 'background-sync hook');
  // the edit filter must include Pi's native edit tool
  assert.match(ext, /EDIT_TOOLS = new Set\(\['edit'/);
  // the shim is resolved next to the extension, never as a machine-specific path
  assert.match(ext, /\.\.\/hooks\/graft-hooks\.cjs/);
  assert.ok(!ext.includes(repo), 'no absolute install path baked into a committed file');

  const again = installPiHooks(repo);
  assert.deepEqual(again.map((x) => x.action), ['unchanged', 'unchanged'], 'idempotent');
  assert.equal(readFileSync(extPath(repo), 'utf8'), ext, 'extension byte-identical on re-run');
});

test('a hand-edited graft extension is restored — the file is graft-owned', () => {
  const repo = fresh();
  installPiHooks(repo);
  writeFileSync(extPath(repo), '// gutted\n');
  const w = installPiHooks(repo);
  assert.ok(w.some((x) => x.id === 'pi-hooks' && x.action === 'updated'));
  assert.equal(readFileSync(extPath(repo), 'utf8'), piExtension());
});

test("a foreign extension next to graft's is left alone", () => {
  const repo = fresh();
  mkdirSync(join(repo, '.pi', 'extensions'), { recursive: true });
  const mine = join(repo, '.pi', 'extensions', 'mine.ts');
  writeFileSync(mine, 'export default () => {};\n');
  installPiHooks(repo);
  assert.equal(readFileSync(mine, 'utf8'), 'export default () => {};\n');
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

// ── runHostsInit wiring ─────────────────────────────────────────────────────

test('runHostsInit --agents pi writes the repo-local hook files and never touches ~/.pi', () => {
  const home = fresh(); const repo = fresh();
  const r = runHostsInit(repo, { home, agents: ['pi'] });
  assert.ok(existsSync(extPath(repo)), 'extension written in the repo');
  assertRunnableShim(shimPath(repo), 'shim written in the repo');
  assert.ok(r.hooks.some((h) => h.id === 'pi-hooks'), 'reported in result.hooks');
  assert.ok(!existsSync(join(home, '.pi')), 'no ~/.pi writes');
});

test('pi hooks are repo-local, so --no-global does NOT suppress them', () => {
  const home = fresh(); const repo = fresh();
  runHostsInit(repo, { home, agents: ['pi'], global: false });
  assert.ok(existsSync(extPath(repo)), '--no-global keeps the repo-local Pi extension');
});

test('--no-hooks skips the Pi hook files (skill still written)', () => {
  const home = fresh(); const repo = fresh();
  const r = runHostsInit(repo, { home, agents: ['pi'], hooks: false });
  assert.ok(!existsSync(extPath(repo)), 'no extension under --no-hooks');
  assert.ok(!existsSync(shimPath(repo)), 'no shim under --no-hooks');
  assert.ok(!r.hooks.some((h) => h.id?.startsWith('pi')), 'no pi hook writes reported');
  assert.ok(existsSync(join(repo, '.pi', 'skills', 'graft', 'SKILL.md')), 'the skill is still written');
});
