/**
 * Which optional Pi packages graft's staged config can activate — report only.
 *
 * Everything graft writes for Pi is inert config waiting on a community
 * extension: `.pi/mcp.json` needs an MCP client (`pi-mcp-extension`), the
 * `hooks` block in `.pi/settings.json` needs a Claude-compatible hook runner
 * (`@hsingjui/pi-hooks`, or graft's own `@kedra/pi-hooks` when it exists).
 * This probe answers "installed?" so init can say which tiers are live and
 * which are staged — it never gates a write: an absent extension means the
 * config self-activates the day the user installs it.
 *
 * Two places pi records an install: the `packages`/`extensions` arrays in
 * settings.json (project `.pi/` and user-level `~/.pi/agent/`), and the
 * unpacked package under `.pi/npm/node_modules/` (scoped names nest one
 * level). Both are scanned, since a package can be installed without a
 * settings entry (e.g. linked locally) and vice versa.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** The MCP client `.pi/mcp.json` is written for. */
const MCP_CLIENTS = ['pi-mcp-extension'];
/**
 * Extensions that execute the Claude-format `hooks` block. Deliberately a
 * list of exact package names, not a `*hooks*` substring: `pi-hooks` on npm
 * is an unrelated extension collection, and other hook packages use their
 * own config format and would never run these entries.
 */
const HOOK_RUNNERS = ['@hsingjui/pi-hooks', '@kedra/pi-hooks', 'pi-claude-hooks'];

export interface PiCapabilities {
  /** The installed MCP client package, or null when the tier is staged. */
  mcp: string | null;
  /** The installed Claude-compatible hook runner, or null when staged. */
  hooks: string | null;
}

/** `packages`/`extensions` entries from a settings.json — strings or
 *  `{source, …}` objects; anything else is ignored rather than fatal. */
function specsInSettings(path: string): string[] {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
  if (typeof root !== 'object' || root === null) return [];
  const out: string[] = [];
  for (const key of ['packages', 'extensions']) {
    const arr = root[key];
    if (!Array.isArray(arr)) continue;
    for (const e of arr) {
      if (typeof e === 'string') out.push(e);
      else if (e && typeof e === 'object') {
        for (const k of ['source', 'name', 'path', 'url']) {
          const v = (e as Record<string, unknown>)[k];
          if (typeof v === 'string') out.push(v);
        }
      }
    }
  }
  return out;
}

/** Package names unpacked under `<piDir>/npm/node_modules`, where a scoped
 *  `@scope/name` install is a nested pair of directories. */
function specsInInstallDir(piDir: string): string[] {
  const nm = join(piDir, 'npm', 'node_modules');
  if (!existsSync(nm)) return [];
  const out: string[] = [];
  try {
    for (const e of readdirSync(nm, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (!e.name.startsWith('@')) { out.push(e.name); continue; }
      for (const s of readdirSync(join(nm, e.name), { withFileTypes: true })) {
        if (s.isDirectory()) out.push(`${e.name}/${s.name}`);
      }
    }
  } catch {
    return out; // a half-written install dir reports what it has
  }
  return out;
}

/**
 * Does a recorded spec name package `p`? Specs arrive as `npm:<name>`,
 * `npm:<name>@<ver>`, bare names from the node_modules scan, or local/git
 * paths — so normalize by dropping the source prefix and any version suffix,
 * then match exactly or at a path boundary. A substring test would let
 * `pi-mcp-extension` report a `pi-mcp-extension-fork`, and the boundary
 * keeps `@hsingjui/pi-hooks` matching a `git:…/hsingjui/pi-hooks` URL too.
 */
function specNames(spec: string, p: string): boolean {
  const norm = spec.replace(/^\w+:/, '').replace(/@[^@/]*$/, '');
  return norm === p || norm.endsWith(`/${p.replace(/^@/, '')}`);
}

/** The installed capability packages visible from `repo`, as package names. */
export function piCapabilities(repo: string, home: string = homedir()): PiCapabilities {
  const candidates = [
    ...specsInSettings(join(home, '.pi', 'agent', 'settings.json')),
    ...specsInSettings(join(repo, '.pi', 'settings.json')),
    ...specsInInstallDir(join(home, '.pi', 'agent')),
    ...specsInInstallDir(join(repo, '.pi')),
  ];
  const match = (list: string[]): string | null =>
    list.find((p) => candidates.some((c) => specNames(c, p))) ?? null;
  return { mcp: match(MCP_CLIENTS), hooks: match(HOOK_RUNNERS) };
}
