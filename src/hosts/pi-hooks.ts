/**
 * Pi's active layer, via a Claude-compatible hook runner.
 *
 * Pi has no command-hook config of its own: its extension API is the hook
 * system, and command hooks come from a *runner extension* that reads a
 * `hooks` key in `.pi/settings.json` (Claude Code format — matcher groups of
 * `type: "command"` entries) and spawns each command with the event payload
 * on stdin. `@hsingjui/pi-hooks` is that runner today; any extension honoring
 * the same contract works.
 *
 * So graft writes two repo-local things, exactly like `.pi/mcp.json` waits
 * for `pi-mcp-extension`:
 *
 *   - `.pi/hooks/graft-hooks.cjs` — the same shim Claude Code and Codex run,
 *     so `src/claude/hooks.ts` stays the single implementation
 *   - a `hooks` block in `.pi/settings.json`, mapping the four graft hooks:
 *       SessionStart      → `session-start` : orientation from `graft/INDEX.md`
 *       UserPromptSubmit  → `prompt`        : the coupling-seed retrieval pack
 *       PostToolUse(edit) → `post-edit`     : blast radius + mark the graph dirty
 *       Stop              → `stop`          : one background graph sync per turn
 *
 * The block is *staged*: written whether or not a runner is installed, inert
 * until one is (nothing reads `hooks` without it). That is the capability
 * ladder — skill only, +MCP, +hooks — decided by which pi packages the user
 * has, never by a graft flag.
 *
 * Both writes are repo-local, like Cursor's hooks and unlike Codex's
 * `~/.codex` set: `--no-global` does not suppress them; `--no-hooks` does.
 *
 * Two runner-side details are worth naming. `PostToolUse`'s matcher is pi's
 * own mutating tools (`edit`, `write`), whose input carries the file as
 * `path` — `editedFilePath` in hooks.ts already reads that shape. And the
 * runner's `Stop` fires on `agent_end`, more often than `agent_settled`:
 * harmless, since the sync is dirty-gated and lock-held, but the reason a
 * graft-owned runner would prefer `agent_settled`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hooksShim } from '../claude/shim-template.js';
import { claudeDistDir } from '../claude/paths.js';
import type { PlannedWrite } from './plan.js';
import { writeOwned, isGraftEntry, readJsonObject, type ConfigWrite } from './config-write.js';

/** Pi's built-in file-mutating tools; their input carries the file as `path`. */
const EDIT_MATCHER = 'edit|write';

function shimPathFor(repo: string): string {
  return join(repo, '.pi', 'hooks', 'graft-hooks.cjs');
}
function settingsPathFor(repo: string): string {
  return join(repo, '.pi', 'settings.json');
}

/**
 * The files a Pi hook install would touch — pure, no writes. Both are
 * repo-local and unconditional: what we write is the repo's own `.pi/`, and
 * the settings entry is inert without a runner to execute it.
 */
export function piHookTargets(repo: string): PlannedWrite[] {
  return [
    {
      hostId: 'pi', id: 'pi-hook-shim',
      path: shimPathFor(repo),
      scope: 'repo', kind: 'hook', what: 'hook shim',
    },
    {
      hostId: 'pi', id: 'pi-hooks',
      path: settingsPathFor(repo),
      scope: 'repo', kind: 'hook', what: 'SessionStart / UserPromptSubmit / PostToolUse / Stop hook entries',
    },
  ];
}

/**
 * The graft hook entries Pi's settings.json should carry — the Claude Code
 * shape every runner reads, mirroring the Codex set. `matcher` is omitted
 * where the event has nothing to match against (SessionStart fires for every
 * source, Stop for every end). `timeout` is in *seconds* — the runner's
 * convention, not the milliseconds graft passes to its own children.
 *
 * The command names the shim *relative to the project*: the runner spawns it
 * with the project dir as cwd, and a relative path keeps a committed
 * settings.json free of machine-specific absolute paths (the same rule the
 * MCP launch entries follow).
 */
interface DesiredEntry { event: string; matcher?: string; sub: string; timeout: number; }
function desiredEntries(): DesiredEntry[] {
  return [
    { event: 'SessionStart', sub: 'session-start', timeout: 10 },
    { event: 'UserPromptSubmit', sub: 'prompt', timeout: 15 },
    { event: 'PostToolUse', matcher: EDIT_MATCHER, sub: 'post-edit', timeout: 10 },
    { event: 'Stop', sub: 'stop', timeout: 10 },
  ];
}

/**
 * Install graft's Pi hook layer in `repo`: own the shim wholesale, merge the
 * hook entries into the user's settings.json. Same merge posture as the Codex
 * hooks installer — foreign hook entries and foreign settings keys
 * (`packages`, `shellPath`, …) are preserved, prior graft entries are
 * replaced rather than stacked, and an unparseable file is never rewritten.
 */
export function installPiHooks(repo: string): ConfigWrite[] {
  const shimPath = shimPathFor(repo);
  const shimWrite = writeOwned('pi-hook-shim', shimPath, hooksShim(claudeDistDir()), 0o755);
  const cfgPath = settingsPathFor(repo);
  const skipped: ConfigWrite = { id: 'pi-hooks', path: cfgPath, action: 'skipped-unparseable' };

  const loaded = readJsonObject(cfgPath);
  if (loaded === 'unparseable') return [shimWrite, skipped];
  const { root, existed } = loaded;
  const before = JSON.stringify(root);
  const hooks = (root.hooks ??= {});
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return [shimWrite, skipped];

  for (const d of desiredEntries()) {
    if (hooks[d.event] !== undefined && !Array.isArray(hooks[d.event])) return [shimWrite, skipped];
    const prior: unknown[] = Array.isArray(hooks[d.event]) ? hooks[d.event] : [];
    const handler = { type: 'command', command: `node ".pi/hooks/graft-hooks.cjs" ${d.sub}`, timeout: d.timeout };
    const entry = d.matcher ? { matcher: d.matcher, hooks: [handler] } : { hooks: [handler] };
    // Preserve foreign entries in this event; replace any prior graft entry so
    // an upgrade re-points to the current command instead of stacking.
    hooks[d.event] = [...prior.filter((e) => !isGraftEntry(e)), entry];
  }

  if (JSON.stringify(root) === before) return [shimWrite, { id: 'pi-hooks', path: cfgPath, action: 'unchanged' }];
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, `${JSON.stringify(root, null, 2)}\n`);
  return [shimWrite, { id: 'pi-hooks', path: cfgPath, action: existed ? 'updated' : 'created' }];
}
