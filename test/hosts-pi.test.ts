/**
 * First-class pi coding agent host: a graft-owned skill file at
 * `.agents/skills/graft/SKILL.md` (pi reads the Agent Skills standard from
 * there), detected via pi-specific markers only (`~/.pi`, repo `.pi`) so the
 * auto-detect never collides with Antigravity's workspace-`.agents` marker.
 * No MCP target in this phase — pi routes graft through the skill/CLI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectHosts, HOSTS } from '../src/hosts/registry.js';
import { mcpTargets } from '../src/hosts/mcp-config.js';
import { runHostsInit } from '../src/hosts/init.js';
import { planInit } from '../src/hosts/plan.js';
import { runRetract } from '../src/hosts/retract.js';

function fresh(): string {
  return mkdtempSync(join(tmpdir(), 'graft-pi-'));
}
const probe = (home: string, repo: string, dirs: string[]) => ({
  home,
  repo,
  dirExists: (p: string) => dirs.some((d) => p === join(home, d) || p === join(repo, d)),
});

test('pi detects on ~/.pi and repo .pi, not on bare .agents', () => {
  const home = fresh(), repo = fresh();
  const ids = (dirs: string[]) => detectHosts(probe(home, repo, dirs)).map((h) => h.id);
  assert.ok(ids(['.pi']).includes('pi'), '~/.pi → pi');
  assert.ok(ids(['.pi']).includes('pi') === ids([join('.pi')]).includes('pi'));
  // A workspace `.agents` dir is Antigravity's marker — it must NOT light up pi…
  const agentsOnly = ids(['.agents']);
  assert.ok(!agentsOnly.includes('pi'), '.agents alone is not pi');
  assert.ok(agentsOnly.includes('antigravity'), '.agents alone is antigravity');
  // …and a repo-local .pi must not drag antigravity in.
  const piOnly = ids(['.pi']);
  assert.ok(piOnly.includes('pi') && !piOnly.includes('antigravity'), '.pi alone is pi only');
});

test('pi is a graft-owned skill at .agents/skills/graft/SKILL.md with no MCP target', () => {
  const host = HOSTS.find((h) => h.id === 'pi')!;
  assert.equal(host.kind, 'owned');
  assert.equal(host.relPath, join('.agents', 'skills', 'graft', 'SKILL.md'));
  assert.ok(host.content().includes('graft ask'), 'skill teaches the CLI');
  assert.deepEqual(mcpTargets('/repo', ['pi']), [], 'no MCP target in this phase');
});

test("runHostsInit --agents pi writes the skill, idempotently", () => {
  const home = fresh(), repo = fresh();
  mkdirSync(join(home, '.pi'), { recursive: true });
  const skill = join(repo, '.agents', 'skills', 'graft', 'SKILL.md');
  const first = runHostsInit(repo, { agents: ['pi'], home });
  assert.deepEqual(first.written.map((w) => w.id), ['pi']);
  assert.ok(existsSync(skill) && readFileSync(skill, 'utf8').includes('graft ask'), 'skill written');
  const second = runHostsInit(repo, { agents: ['pi'], home });
  assert.ok(second.written.every((w) => w.action === 'unchanged'), 're-run is a no-op');
});

test('planInit covers pi with exactly one repo-scoped write', () => {
  const repo = fresh();
  const plan = planInit(repo, { home: fresh(), ids: ['pi'] });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].writes.length, 1);
  const w = plan[0].writes[0];
  assert.equal(w.scope, 'repo');
  assert.equal(w.kind, 'instruction');
  assert.ok(w.path.endsWith(join('.agents', 'skills', 'graft', 'SKILL.md')));
});

test('retract removes the pi skill cleanly', () => {
  const home = fresh(), repo = fresh();
  mkdirSync(join(home, '.pi'), { recursive: true });
  runHostsInit(repo, { agents: ['pi'], home });
  const skill = join(repo, '.agents', 'skills', 'graft', 'SKILL.md');
  assert.ok(existsSync(skill));
  runRetract(repo, { home, apply: true });
  assert.ok(!existsSync(skill), 'skill removed');
});
