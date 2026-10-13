/**
 * frozen-path-guard — deterministic write-deny on spec-frozen paths for the
 * write-capable gate children, the enforce EDIT pass especially.
 *
 * The failure class: a spec's CONSTRAINTS pin a path as off-limits ("**Do NOT
 * modify** `src/server/index.ts`"), and a later write-enabled GATE pass edits it
 * anyway. The enforce child runs with `ENFORCE_TOOLS = 'read,edit'`, its edits
 * are judged only for guideline compliance, and they are then committed as an
 * `ENFORCE GUIDELINES` snapshot on top of the verified task — so the frozen
 * contract gets mutated by the very pass meant to police the work.
 *
 * A tool-layer deny is not available. pi 0.84.4 offers `--tools` and
 * `--exclude-tools`, both allow/deny by tool NAME; no flag scopes an edit to a
 * path. A chmod-style physical deny would leave the child thrashing on a bare
 * EACCES, and the enforce child has NO WALL CLOCK to stop it — the `gate` row of
 * WORKER_PROFILES sets `worker-timeout` to `{timeoutMs: 0}`, leaving only a
 * per-command watchdog and a stream watchdog.
 *
 * So the achievable deny is after the fact: let the pass edit freely, then
 * deterministically UNDO any frozen-path change before those edits can be
 * committed. No model is in the loop, the same discipline as git-state-guard.
 *
 * Everything degrades to a no-op when the spec froze nothing — a single-`/task`
 * run, or a spec with no `Do NOT modify` line naming a path — and on any git
 * error. Pure git shape, zero stack assumptions: a frozen path exists for a CLI,
 * a library or a script collection exactly as for a web app.
 */
import {extractProhibitions} from './prohibition-probe.js'
import {statusEntriesFromCwd} from '../shared/git-runner.js'

/** Run a git subcommand in the guard's cwd; only stdout + exit code are read. */
export type FrozenGit = (args: string[]) => Promise<{stdout: string; exitCode: number}>

/**
 * The concrete paths the spec forbids modifying, normalized and de-duplicated —
 * `extractProhibitions`, the same extraction the verify prohibition probe
 * (gate-deps.ts) and the compose-time conflict detector (frozen-conflict.ts)
 * consume, so "frozen" means one thing across the gates.
 *
 * Normalisation strips a leading `./` and a trailing `/`: measured, a spec
 * banning `` `./src/a.ts` `` and `` `src/b/` `` yields `src/a.ts` and `src/b`.
 * A null spec, or one with no modification-ban line naming a path, yields an
 * empty list and the guard is a no-op by construction.
 */
export function frozenPathsFromSpec(spec: string | null | undefined): string[] {
    if (!spec) return []
    const seen = new Set<string>()
    for (const p of extractProhibitions(spec)) {
        const n = p.path.replace(/^\.\//, '').replace(/\/+$/, '')
        if (n.length > 0) seen.add(n)
    }
    return [...seen]
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Does this prose or tool-output text NAME the given path? Word-bounded on both
 * sides. Measured against `tsconfig.json`: `` `tsconfig.json` ``,
 * `(tsconfig.json:18)` and a bare mention all match; `foo.tsconfig.json`,
 * `config/tsconfig.json` (a different file), `tsconfig.json5` and
 * `tsconfig.json.bak` all do not. Shared by the compose-time unsatisfiable-pair
 * detector (frozen-conflict.ts) and lint-fix's non-convergence trace, so "the
 * text names a frozen path" means one thing.
 */
export function pathNamedIn(text: string, path: string): boolean {
    const p = path.replace(/^\.\//, '').replace(/\/+$/, '')
    if (p.length === 0) return false
    return new RegExp(`(?:^|[^\\w./-])${escapeRe(p)}(?!\\.?[\\w-])`, 'im').test(text)
}

/** Status codes of a conflicted file. A checkout from HEAD would end its conflict. */
const UNMERGED = /^(DD|AU|UD|UA|DU|AA|UU)$/

/** The sources of the renames that added these files, wherever they sit. */
async function renameSourcesOf(added: string[], git: FrozenGit): Promise<string[]> {
    if (added.length === 0) return []
    // Status scoped to the destination reports an added file, not a rename.
    const {entries} = await statusEntriesFromCwd(git, ['--untracked-files=no'])
    const wanted = new Set(added)
    return entries.flatMap(e => (e.from !== undefined && wanted.has(e.path) ? [e.from] : []))
}

/**
 * Restore the spec-frozen paths to their committed (HEAD) state, undoing any
 * change a just-run write-capable gate child made to them, and return the list of
 * files that had to be reverted (empty ⇒ the pass respected every frozen path).
 *
 * The gate runs it AFTER the task's own work is committed (HEAD), so "restore to
 * HEAD" keeps the verified task's version of the frozen file and discards ONLY the
 * gate child's edit on top of it — the task's own frozen-path edits, if any, are a
 * separate concern the verify prohibition probe surfaces. `git checkout -f HEAD`
 * with `--no-overlay` restores every changed file git tracks and removes the ones
 * HEAD lacks, staged or intent-to-add; `git clean -fdq` removes untracked files the
 * pass created. Both are scoped to the frozen pathspec, except a rename's source:
 * it can sit outside it, and restoring the rename without it would leave the
 * source deleted. Its working copy comes from `base`, the tree before the pass,
 * since HEAD lacks any uncommitted work in it.
 *
 * Run against a real repo with one frozen directory and one free one: a modified
 * file came back to its HEAD content, a deleted file came back, and two untracked
 * creations (one with a space in its name) were removed, while an edit to a file
 * OUTSIDE the pathspec survived untouched.
 *
 * A conflicted file is left as it is and not reported reverted.
 *
 * Best-effort: an empty frozen list, a non-git tree, or any git error yields an
 * empty result — the guard must never break the gate on a project it cannot reason
 * about.
 */
export async function revertFrozenPaths(
    paths: string[],
    git: FrozenGit,
    base = 'HEAD'
): Promise<string[]> {
    if (paths.length === 0) return []
    const {entries, exitCode} = await statusEntriesFromCwd(git, ['--', ...paths])
    if (exitCode !== 0 || entries.length === 0) return []
    // A name git tracks in neither HEAD nor the index fails the whole checkout, and
    // a name is a glob to a pathspec unless it is literal.
    const settled = entries.filter(e => !UNMERGED.test(e.code))
    const tracked = new Set(
        settled
            .filter(e => e.code !== '??')
            .flatMap(e => (e.from === undefined ? [e.path] : [e.path, e.from]))
    )
    const sources = await renameSourcesOf(
        settled.filter(e => e.code.includes('A') && e.from === undefined).map(e => e.path),
        git
    )
    for (const source of sources) tracked.add(source)
    const restored =
        tracked.size === 0
        || (
            await git([
                '--literal-pathspecs',
                'checkout',
                '--no-overlay',
                '-f',
                'HEAD',
                '--',
                ...tracked
            ])
        ).exitCode === 0
    if (restored && base !== 'HEAD' && sources.length > 0)
        await git([
            '--literal-pathspecs',
            'restore',
            `--source=${base}`,
            '--worktree',
            '--',
            ...sources
        ])
    await git(['--literal-pathspecs', 'clean', '-fdq', '--', ...paths])
    const reverted = settled.filter(e => restored || e.code === '??')
    return [...new Set(reverted.map(e => e.path))]
}
