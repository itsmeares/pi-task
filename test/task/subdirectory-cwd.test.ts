/**
 * A task run from a package inside a repo. `git status --porcelain` and the diff
 * family name paths from the repo root; `ls-files`, pathspecs and `path.join(cwd, …)`
 * read them from cwd. Every site below mixed the two, so from `app/` it read the
 * wrong file, missed an artifact, or failed open.
 */
import {expect, setDefaultTimeout, test} from 'bun:test'
import {execFileSync, spawn} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {tmpDir} from '../test-utils/tmp-dir.js'
import {fakeSpawnByPrompt} from '../test-utils/fake-spawn.js'
import type {SpawnFn} from '../../src/shared/child-process.js'
import {makeGit, statusFromCwd} from '../../src/shared/git-runner.js'
import {
    collectChangedFiles,
    collectIgnoredSnapshot,
    collectTaskTreeChanges,
    collectTreeChanges
} from '../../src/task/gate-deps.js'
import {captureCommitDiff} from '../../src/task/enforce-guidelines.js'
import {captureGitState, reconcileGitState} from '../../src/task/git-state-guard.js'
import {lazyHealthBaseline} from '../../src/task/health-baseline.js'
import {gitCommitAll, gitDropLastCommit} from '../../src/task/auto-commit.js'
import {revertFrozenPaths} from '../../src/task/frozen-path-guard.js'
import {runBoundedLintFix, type LintFixResult} from '../../src/task/lint-fix.js'

// Real git subprocesses, several per test.
setDefaultTimeout(30_000)

function repo(pkg = 'app'): {dir: string; app: string; g: (...a: string[]) => string} {
    const dir = tmpDir('pi-subdir-')
    const g = (...a: string[]): string =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
            cwd: dir,
            encoding: 'utf8'
        }).trim()
    g('init', '-q', '-b', 'main')
    g('config', 'core.autocrlf', 'false')
    const app = path.join(dir, pkg)
    fs.mkdirSync(app)
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 1\n')
    fs.writeFileSync(path.join(app, '.gitignore'), '.env\n')
    fs.writeFileSync(path.join(dir, 'sibling.ts'), 'export const s = 1\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'base')
    return {dir, app, g}
}

test('statusFromCwd names every path from cwd', async () => {
    const {app} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    fs.writeFileSync(path.join(app, 'my new.ts'), 'x\n')
    const r = await statusFromCwd(makeGit(app), ['--', '.'])
    expect(r.stdout.split('\n').filter(Boolean).sort()).toEqual([' M a.ts', '?? "my new.ts"'])
})

// Porcelain octal-escapes a non-ASCII path, and the raw prefix never matched it.
test('statusFromCwd names a path in a non-ASCII package from cwd', async () => {
    const {app} = repo('pkg-ü')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    const r = await statusFromCwd(makeGit(app), ['--', '.'])
    expect(r.stdout.trim()).toBe('M a.ts')
})

// A pathspec can reach outside cwd. Its root name read from cwd is another file.
test('statusFromCwd names a path outside cwd as one cwd can open', async () => {
    const {dir, app} = repo()
    fs.writeFileSync(path.join(dir, 'sibling.ts'), 'export const s = 2\n')
    const r = await statusFromCwd(makeGit(app), ['--', '../sibling.ts'])
    expect(r.stdout.trim()).toBe('M ../sibling.ts')
})

test('the tree changes name the edited file from cwd', async () => {
    const {app} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    expect((await collectTreeChanges(app)).modified).toEqual(['a.ts'])
})

test('the tree changes do not count a copy source as deleted under user copy detection', async () => {
    const {app, g} = repo()
    g('config', 'diff.renames', 'copies')
    const body = Array.from({length: 40}, (_, i) => `export const v${i} = ${i}\n`).join('')
    fs.writeFileSync(path.join(app, 'a.ts'), body)
    g('add', '-A')
    g('commit', '-q', '-m', 'body')
    fs.appendFileSync(path.join(app, 'a.ts'), 'export const child = 1\n')
    fs.copyFileSync(path.join(app, 'a.ts'), path.join(app, 'b.ts'))
    g('add', '-A')
    expect(g('status', '--porcelain')).toContain('C  app/a.ts -> app/b.ts')
    expect(await collectTreeChanges(app)).toEqual({
        modified: ['a.ts'],
        deleted: [],
        added: ['b.ts']
    })
})

test('statusFromCwd reports no copy under user copy detection', async () => {
    const {app, g} = repo()
    g('config', 'status.renames', 'copies')
    const body = Array.from({length: 40}, (_, i) => `export const v${i} = ${i}\n`).join('')
    fs.writeFileSync(path.join(app, 'a.ts'), body)
    g('add', '-A')
    g('commit', '-q', '-m', 'body')
    fs.appendFileSync(path.join(app, 'a.ts'), 'export const child = 1\n')
    fs.copyFileSync(path.join(app, 'a.ts'), path.join(app, 'b.ts'))
    g('add', '-N', 'app/b.ts')
    expect(g('status', '--porcelain')).toContain(' C app/a.ts -> app/b.ts')
    const r = await statusFromCwd(makeGit(app), ['--', '.'])
    expect(r.stdout.split('\n').filter(Boolean).sort()).toEqual([' A b.ts', ' M a.ts'])
})

test('the tree changes count a renamed file the child then removed as deleted', async () => {
    const {app, g} = repo()
    fs.mkdirSync(path.join(app, 'tmp'))
    g('mv', 'app/a.ts', 'app/tmp/a.ts')
    fs.rmSync(path.join(app, 'tmp', 'a.ts'))
    expect(g('status', '--porcelain')).toContain('RD app/a.ts -> app/tmp/a.ts')
    expect(await collectTreeChanges(app)).toEqual({modified: [], deleted: ['a.ts'], added: []})
})

test('the committed fallback names the file from cwd', async () => {
    const {app, g} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    g('commit', '-qam', 'work')
    expect((await collectTaskTreeChanges(app)).modified).toEqual(['a.ts'])
})

test('the changed-file probe reads the file it names', async () => {
    const {app} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    expect((await collectChangedFiles(app)).map(f => f.path)).toEqual(['a.ts'])
})

test('a write to an ignored .env is in the snapshot', async () => {
    const {app} = repo()
    fs.writeFileSync(path.join(app, '.env'), 'A=1\n')
    expect(Object.keys(await collectIgnoredSnapshot(app))).toEqual(['.env'])
})

test('the enforce child is told files it can open', async () => {
    const {app, g} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    g('commit', '-qam', 'work')
    const text = await captureCommitDiff(app)
    expect(text).toContain('\n- a.ts')
    expect(text).not.toContain('app/a.ts')
})

// The guard's tracked set comes from `ls-tree`, which names from cwd. Matching it
// against root names read a tracked artifact as untracked: benign, not graded.
test('a rewrite of a TRACKED test-results file still taints', async () => {
    const {app, g} = repo()
    fs.mkdirSync(path.join(app, 'test-results'))
    fs.writeFileSync(path.join(app, 'test-results', 'r.json'), '{}\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'tracked artifact')
    const snap = await captureGitState(app)
    fs.writeFileSync(path.join(app, 'test-results', 'r.json'), '{"x":1}\n')
    expect((await reconcileGitState(app, snap)).verdictTainted).toBe(true)
})

test('the lazy baseline runs in the same package of its worktree', async () => {
    const {app} = repo()
    let ran = ''
    await lazyHealthBaseline({
        git: makeGit(app),
        runHealthIn: d => {
            ran = d
            return Promise.resolve({
                ok: true,
                reason: 'passed',
                ecosystem: 'none',
                output: '',
                commands: []
            })
        }
    })
    expect(path.basename(ran)).toBe('app')
})

test("a task's commit leaves a sibling package's edit alone", async () => {
    const {dir, app, g} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    fs.writeFileSync(path.join(dir, 'sibling.ts'), 'export const s = 2\n')
    expect((await gitCommitAll(app, 'task')).committed).toBe(true)
    expect(g('show', '--name-only', '--format=', 'HEAD')).toBe('app/a.ts')
})

// `git add -- .` scoped the staging, but the commit took the whole index.
test("a task's commit leaves out a sibling's staged edit", async () => {
    const {dir, app, g} = repo()
    fs.writeFileSync(path.join(dir, 'sibling.ts'), 'export const s = 2\n')
    g('add', 'sibling.ts')
    expect((await gitCommitAll(app, 'task')).reason).toBe('nothing to commit')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    expect((await gitCommitAll(app, 'task')).committed).toBe(true)
    expect(g('show', '--name-only', '--format=', 'HEAD')).toBe('app/a.ts')
    expect(g('diff', '--cached', '--name-only')).toBe('sibling.ts')
})

test("a task's commit records a file it deleted", async () => {
    const {app, g} = repo()
    fs.rmSync(path.join(app, 'a.ts'))
    expect((await gitCommitAll(app, 'task')).committed).toBe(true)
    expect(g('show', '--name-status', '--format=', 'HEAD')).toBe('D\tapp/a.ts')
})

// The task commit no longer holds a sibling's edit, so a repo-wide reset of the
// enforce commit threw it away.
test("dropping the enforce commit keeps a sibling's uncommitted edit", async () => {
    const {dir, app, g} = repo()
    fs.writeFileSync(path.join(dir, 'sibling.ts'), 'export const s = 2\n')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    await gitCommitAll(app, 'task')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 3\n')
    fs.writeFileSync(path.join(app, 'added.ts'), 'x\n')
    await gitCommitAll(app, 'ENFORCE GUIDELINES')
    await gitDropLastCommit(app)
    expect(g('log', '-1', '--format=%s')).toBe('task')
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 2\n')
    expect(fs.existsSync(path.join(app, 'added.ts'))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'sibling.ts'), 'utf8')).toBe('export const s = 2\n')
    expect(g('status', '--porcelain')).toBe('M sibling.ts')
})

test('a frozen-path revert names the files it reverted from cwd', async () => {
    const {app} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    expect(await revertFrozenPaths(['a.ts'], makeGit(app))).toEqual(['a.ts'])
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
})

// A file name is a glob to a pathspec: `[pkg]/a.ts` also names `p/a.ts`.
test('dropping the enforce commit keeps a sibling whose name its files match as a glob', async () => {
    const {dir, app, g} = repo('[pkg]')
    fs.mkdirSync(path.join(dir, 'p'))
    fs.writeFileSync(path.join(dir, 'p', 'a.ts'), 'export const p = 1\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'task')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 3\n')
    await gitCommitAll(app, 'ENFORCE GUIDELINES')
    fs.writeFileSync(path.join(dir, 'p', 'a.ts'), 'export const p = 2\n')
    const dropped = await gitDropLastCommit(app)
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(fs.readFileSync(path.join(dir, 'p', 'a.ts'), 'utf8')).toBe('export const p = 2\n')
    expect(dropped).toBe(true)
})

test('dropping the enforce commit works under a diff.relative config', async () => {
    const {app, g} = repo()
    g('config', 'diff.relative', 'true')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 3\n')
    await gitCommitAll(app, 'ENFORCE GUIDELINES')
    const dropped = await gitDropLastCommit(app)
    expect(g('log', '-1', '--format=%s')).toBe('base')
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(dropped).toBe(true)
})

// The re-verify's build can rewrite a tracked file after the enforce commit.
test('dropping the enforce commit discards what the re-verify wrote in cwd', async () => {
    const {app, g} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 3\n')
    await gitCommitAll(app, 'ENFORCE GUIDELINES')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 4\n')
    fs.writeFileSync(path.join(app, '.gitignore'), 'built\n')
    const dropped = await gitDropLastCommit(app)
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(fs.readFileSync(path.join(app, '.gitignore'), 'utf8')).toBe('.env\n')
    expect(g('status', '--porcelain')).toBe('')
    expect(dropped).toBe(true)
})

test('a drop that cannot happen says so', async () => {
    const {app} = repo()
    expect(await gitDropLastCommit(app)).toBe(false)
})

test('a drop that cannot happen leaves cwd as it was', async () => {
    const {app} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    expect(await gitDropLastCommit(app)).toBe(false)
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 2\n')
})

// The enforce commit deleted a file, and the re-verify's build wrote it back untracked.
test('dropping the enforce commit restores a deleted file the re-verify wrote back', async () => {
    const {app, g} = repo()
    fs.rmSync(path.join(app, 'a.ts'))
    await gitCommitAll(app, 'ENFORCE GUIDELINES')
    fs.writeFileSync(path.join(app, 'a.ts'), 'built\n')
    const dropped = await gitDropLastCommit(app)
    expect(dropped).toBe(true)
    expect(g('log', '-1', '--format=%s')).toBe('base')
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
})

// git refuses a commit with a pathspec while a merge is in progress.
test("a task's commit concludes a merge in progress", async () => {
    const {app, g} = repo()
    g('checkout', '-q', '-b', 'other')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 5\n')
    g('commit', '-qam', 'other')
    g('checkout', '-q', 'main')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 6\n')
    g('commit', '-qam', 'main')
    try {
        g('merge', '-q', 'other')
    } catch {
        // the conflict is the point
    }
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 7\n')
    g('add', 'app/a.ts')
    expect((await gitCommitAll(app, 'task')).committed).toBe(true)
    expect(g('rev-list', '--parents', '-1', 'HEAD').split(' ')).toHaveLength(3)
})

// rev-parse prints the prefix as it is, and a directory name can begin with a space.
test('the tree changes name a file in a package whose name starts with a space', async () => {
    const {app} = repo(' app')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    expect((await collectTreeChanges(app)).modified).toEqual(['a.ts'])
})

// Status names a non-ASCII path as it is; the committed fallback must match it.
test('the committed fallback names a non-ASCII file as status does', async () => {
    const {app, g} = repo()
    fs.writeFileSync(path.join(app, 'ü.ts'), 'x\n')
    expect((await collectTreeChanges(app)).added).toEqual(['ü.ts'])
    g('add', '-A')
    g('commit', '-q', '-m', 'work')
    expect((await collectTaskTreeChanges(app)).added).toEqual(['ü.ts'])
})

// One untracked name in a checkout's pathspec fails the whole checkout.
test('a frozen-path revert of an edit and a new file undoes both', async () => {
    const {app} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    fs.writeFileSync(path.join(app, 'new.ts'), 'x\n')
    expect((await revertFrozenPaths(['a.ts', 'new.ts'], makeGit(app))).sort()).toEqual([
        'a.ts',
        'new.ts'
    ])
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(fs.existsSync(path.join(app, 'new.ts'))).toBe(false)
})

test('a frozen-path revert undoes an edit beside a frozen path that does not exist', async () => {
    const {app} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    expect(await revertFrozenPaths(['a.ts', 'never.md'], makeGit(app))).toEqual(['a.ts'])
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
})

test('a frozen-path revert undoes an edit beside a wholly new frozen directory', async () => {
    const {app} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    fs.mkdirSync(path.join(app, 'fresh'))
    fs.writeFileSync(path.join(app, 'fresh', 'f.ts'), 'x\n')
    expect((await revertFrozenPaths(['a.ts', 'fresh'], makeGit(app))).sort()).toEqual([
        'a.ts',
        'fresh/'
    ])
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(fs.existsSync(path.join(app, 'fresh'))).toBe(false)
})

test('a frozen-path revert undoes an edit beside an intent-to-add file', async () => {
    const {app, g} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    fs.writeFileSync(path.join(app, 'x.ts'), 'x\n')
    g('add', '-N', 'app/x.ts')
    expect(await revertFrozenPaths(['a.ts', 'x.ts'], makeGit(app))).toEqual(['a.ts', 'x.ts'])
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(fs.existsSync(path.join(app, 'x.ts'))).toBe(false)
    expect(g('status', '--porcelain')).toBe('')
})

test('a frozen-path revert brings back a file removed from the index only', async () => {
    const {app, g} = repo()
    g('rm', '-q', '--cached', 'app/a.ts')
    expect(await revertFrozenPaths(['a.ts'], makeGit(app))).toEqual(['a.ts'])
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(g('status', '--porcelain')).toBe('')
})

test('a frozen-path revert undoes a staged rename', async () => {
    const {app, g} = repo()
    g('mv', 'app/a.ts', 'app/b.ts')
    expect(await revertFrozenPaths(['a.ts', 'b.ts'], makeGit(app))).toEqual(['b.ts'])
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(fs.existsSync(path.join(app, 'b.ts'))).toBe(false)
    expect(g('status', '--porcelain')).toBe('')
})

test('a frozen-path revert undoes a staged new file', async () => {
    const {app, g} = repo()
    fs.writeFileSync(path.join(app, 'y.ts'), 'y\n')
    g('add', 'app/y.ts')
    expect(await revertFrozenPaths(['y.ts'], makeGit(app))).toEqual(['y.ts'])
    expect(g('status', '--porcelain')).toBe('')
})

// Porcelain C-quotes a tab, and the unquoted name is a glob that matches nothing.
test.skipIf(process.platform === 'win32')(
    'a frozen-path revert restores a file whose name holds a tab',
    async () => {
        const {app, g} = repo()
        fs.writeFileSync(path.join(app, 'a\tb.ts'), 'tab\n')
        g('add', '-A')
        g('commit', '-q', '-m', 'tab')
        fs.writeFileSync(path.join(app, 'a\tb.ts'), 'edited\n')
        fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
        expect((await revertFrozenPaths(['.'], makeGit(app))).sort()).toEqual(
            ['a.ts', 'a\tb.ts'].sort()
        )
        expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
        expect(fs.readFileSync(path.join(app, 'a\tb.ts'), 'utf8')).toBe('tab\n')
    }
)

// A file HEAD deleted while the merged branch edited it: the index holds it, HEAD does not.
test('a frozen-path revert restores an edit beside a conflicted file HEAD lacks', async () => {
    const {app, g} = repo()
    fs.writeFileSync(path.join(app, 'c.ts'), 'c\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'c')
    g('checkout', '-q', '-b', 'other')
    fs.writeFileSync(path.join(app, 'c.ts'), 'c2\n')
    g('commit', '-qam', 'other')
    g('checkout', '-q', 'main')
    g('rm', '-q', 'app/c.ts')
    g('commit', '-q', '-m', 'drop c')
    try {
        g('merge', '-q', 'other')
    } catch {
        // the conflict is the point
    }
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    expect(await revertFrozenPaths(['a.ts', 'c.ts'], makeGit(app))).toEqual(['a.ts'])
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
})

// Its first parent is not the tree before it: dropping it would end the merge.
test('a drop refuses an enforce commit that concluded a merge', async () => {
    const {app, g} = repo()
    g('checkout', '-q', '-b', 'other')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 5\n')
    g('commit', '-qam', 'other')
    g('checkout', '-q', 'main')
    g('merge', '-q', '--no-ff', '--no-commit', 'other')
    expect((await gitCommitAll(app, 'ENFORCE GUIDELINES')).committed).toBe(true)
    const head = g('rev-parse', 'HEAD')
    expect(await gitDropLastCommit(app)).toBe(false)
    expect(g('rev-parse', 'HEAD')).toBe(head)
})

// rev-parse resolves a branch named MERGE_HEAD when no merge is in progress.
test("a task's commit leaves out a sibling's staged edit beside a branch named MERGE_HEAD", async () => {
    const {dir, app, g} = repo()
    g('branch', 'MERGE_HEAD')
    fs.writeFileSync(path.join(dir, 'sibling.ts'), 'export const s = 2\n')
    g('add', 'sibling.ts')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    expect((await gitCommitAll(app, 'task')).committed).toBe(true)
    expect(g('show', '--name-only', '--format=', 'HEAD')).toBe('app/a.ts')
})

function reftableRepo(): {app: string; g: (...a: string[]) => string} | null {
    const dir = tmpDir('pi-reftable-')
    const g = (...a: string[]): string =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
            cwd: dir,
            encoding: 'utf8'
        }).trim()
    try {
        g('init', '-q', '-b', 'main', '--ref-format=reftable')
    } catch {
        return null
    }
    const app = path.join(dir, 'app')
    fs.mkdirSync(app)
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 1\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'base')
    return {app, g}
}

// Reftable keeps CHERRY_PICK_HEAD in the ref store, not in a file.
test.skipIf(reftableRepo() === null)(
    "a task's commit concludes a cherry-pick in a reftable repo",
    async () => {
        const {app, g} = reftableRepo()!
        g('checkout', '-q', '-b', 'other')
        fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 5\n')
        g('commit', '-qam', 'other')
        g('checkout', '-q', 'main')
        fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 6\n')
        g('commit', '-qam', 'main')
        try {
            g('cherry-pick', 'other')
        } catch {
            // the conflict is the point
        }
        fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 7\n')
        g('add', 'app/a.ts')
        expect((await gitCommitAll(app, 'task')).committed).toBe(true)
        expect(g('status', '--porcelain')).toBe('')
    }
)

// `checkout -f HEAD` takes HEAD's side of a conflict and ends it.
test('a frozen-path revert leaves a conflicted file conflicted', async () => {
    const {app, g} = repo()
    g('checkout', '-q', '-b', 'other')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 5\n')
    g('commit', '-qam', 'other')
    g('checkout', '-q', 'main')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 6\n')
    g('commit', '-qam', 'main')
    try {
        g('merge', '-q', 'other')
    } catch {
        // the conflict is the point
    }
    fs.writeFileSync(path.join(app, '.gitignore'), 'edited\n')
    expect(await revertFrozenPaths(['a.ts', '.gitignore'], makeGit(app))).toEqual(['.gitignore'])
    expect(g('ls-files', '-u', '--', 'app/a.ts')).not.toBe('')
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toContain('<<<<<<<')
})

// A name from status can hold `[`, and status and clean read it as a glob.
test('a frozen-path revert of a bracketed name keeps the files it matches as a glob', async () => {
    const {app, g} = repo()
    fs.writeFileSync(path.join(app, '[i].ts'), 'export const b = 1\n')
    fs.writeFileSync(path.join(app, 'i.ts'), 'export const i = 1\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'bracket')
    fs.writeFileSync(path.join(app, '[i].ts'), 'export const b = 2\n')
    fs.writeFileSync(path.join(app, 'i.ts'), 'export const i = 2\n')
    expect(await revertFrozenPaths(['[i].ts'], makeGit(app))).toEqual(['[i].ts'])
    expect(fs.readFileSync(path.join(app, '[i].ts'), 'utf8')).toBe('export const b = 1\n')
    expect(fs.readFileSync(path.join(app, 'i.ts'), 'utf8')).toBe('export const i = 2\n')
})

// `reset --soft` refuses mid-merge, and cwd must not be left at the parent under the commit.
test('a drop that git refuses leaves the tree as it was', async () => {
    const {dir, app, g} = repo()
    g('checkout', '-q', '-b', 'other')
    fs.writeFileSync(path.join(dir, 'sibling.ts'), 'export const s = 5\n')
    g('commit', '-qam', 'other')
    g('checkout', '-q', 'main')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 3\n')
    await gitCommitAll(app, 'ENFORCE GUIDELINES')
    g('merge', '-q', '--no-ff', '--no-commit', 'other')
    expect(await gitDropLastCommit(app)).toBe(false)
    expect(g('log', '-1', '--format=%s')).toBe('ENFORCE GUIDELINES')
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 3\n')
    expect(g('diff', 'HEAD', '--name-only', '--', 'app')).toBe('')
})

function lintFixIn(app: string, frozen: string[], child: () => void): Promise<LintFixResult> {
    return runBoundedLintFix({
        cwd: app,
        failReason: 'repo health: `bun run lint` exited 1',
        runChild: () => {
            child()
            return Promise.resolve('LINT-FIX: DONE')
        },
        repoHealth: () => Promise.resolve({ok: true, reason: 'clean'}),
        git: makeGit(app),
        frozenPaths: frozen
    })
}

test('the lint-fix frozen guard undoes a staged rename inside a frozen directory', async () => {
    const {app, g} = repo()
    fs.mkdirSync(path.join(app, 'frozen'))
    fs.writeFileSync(path.join(app, 'frozen', 'a.ts'), 'export const f = 1\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'frozen')
    const r = await lintFixIn(app, ['frozen'], () => g('mv', 'app/frozen/a.ts', 'app/frozen/b.ts'))
    expect(r.class).toBe('frozen-path')
    expect(fs.readFileSync(path.join(app, 'frozen', 'a.ts'), 'utf8')).toBe('export const f = 1\n')
    expect(fs.existsSync(path.join(app, 'frozen', 'b.ts'))).toBe(false)
    expect(g('status', '--porcelain')).toBe('')
})

test.skipIf(process.platform === 'win32')(
    'the lint-fix frozen guard undoes an edit to a frozen file whose name holds a tab',
    async () => {
        const {app, g} = repo()
        fs.mkdirSync(path.join(app, 'frozen'))
        fs.writeFileSync(path.join(app, 'frozen', 'a\tb.ts'), 'tab\n')
        g('add', '-A')
        g('commit', '-q', '-m', 'tab')
        const r = await lintFixIn(app, ['frozen'], () =>
            fs.writeFileSync(path.join(app, 'frozen', 'a\tb.ts'), 'edited\n')
        )
        expect(r.reason).toContain('reverted')
        expect(fs.readFileSync(path.join(app, 'frozen', 'a\tb.ts'), 'utf8')).toBe('tab\n')
    }
)

// Default `status` collapses an untracked directory to one name, so a file the
// child adds inside an already-existing untracked directory is invisible to the
// frozen guard's pre/post diff.
test('the lint-fix frozen guard catches a creation inside a pre-existing untracked directory', async () => {
    const {app} = repo()
    fs.mkdirSync(path.join(app, 'frozen', 'junk'), {recursive: true})
    fs.writeFileSync(path.join(app, 'frozen', 'junk', 'pre.txt'), 'keep\n')
    const r = await lintFixIn(app, ['frozen'], () =>
        fs.writeFileSync(path.join(app, 'frozen', 'junk', 'x.ts'), 'export const x = 1\n')
    )
    expect(r.class).toBe('frozen-path')
    expect(fs.existsSync(path.join(app, 'frozen', 'junk', 'x.ts'))).toBe(false)
    expect(fs.readFileSync(path.join(app, 'frozen', 'junk', 'pre.txt'), 'utf8')).toBe('keep\n')
})

// The checkout names the changed files status reported, which can include a
// rename's source outside the frozen pathspec. Naming it is what restores it.
test('the lint-fix frozen guard undoes a rename whose source sits outside the frozen path', async () => {
    const {dir, app, g} = repo()
    fs.mkdirSync(path.join(app, 'frozen'))
    fs.writeFileSync(path.join(dir, 'outside.ts'), 'export const o = 1\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'outside')
    const r = await lintFixIn(app, ['frozen'], () => g('mv', 'outside.ts', 'app/frozen/b.ts'))
    expect(r.class).toBe('frozen-path')
    expect(fs.readFileSync(path.join(dir, 'outside.ts'), 'utf8')).toBe('export const o = 1\n')
    expect(fs.existsSync(path.join(app, 'frozen', 'b.ts'))).toBe(false)
    expect(g('status', '--porcelain')).toBe('')
})

test('the lint-fix frozen guard undoes an intent-to-add rename into a frozen path', async () => {
    const {dir, app, g} = repo()
    fs.mkdirSync(path.join(app, 'frozen'))
    fs.writeFileSync(path.join(dir, 'outside.ts'), 'export const o = 1\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'outside')
    const r = await lintFixIn(app, ['frozen'], () => {
        fs.renameSync(path.join(dir, 'outside.ts'), path.join(app, 'frozen', 'b.ts'))
        g('add', '-N', 'app/frozen/b.ts')
    })
    expect(r.class).toBe('frozen-path')
    expect(fs.readFileSync(path.join(dir, 'outside.ts'), 'utf8')).toBe('export const o = 1\n')
    expect(fs.existsSync(path.join(app, 'frozen', 'b.ts'))).toBe(false)
    expect(g('status', '--porcelain')).toBe('')
})

// lint-fix runs on uncommitted task work, so HEAD is not the source's state before the child.
test('the lint-fix frozen guard keeps the task edit of a file renamed into a frozen path', async () => {
    const {dir, app, g} = repo()
    fs.mkdirSync(path.join(app, 'frozen'))
    fs.writeFileSync(path.join(dir, 'outside.ts'), 'export const o = 1\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'outside')
    fs.writeFileSync(path.join(dir, 'outside.ts'), 'export const o = 2\n')
    const r = await lintFixIn(app, ['frozen'], () => g('mv', 'outside.ts', 'app/frozen/b.ts'))
    expect(r.class).toBe('frozen-path')
    expect(fs.readFileSync(path.join(dir, 'outside.ts'), 'utf8')).toBe('export const o = 2\n')
    expect(fs.existsSync(path.join(app, 'frozen', 'b.ts'))).toBe(false)
})

test('the lint-fix frozen guard pairs a rename when the user turned rename detection off', async () => {
    const {dir, app, g} = repo()
    g('config', 'status.renames', 'false')
    fs.mkdirSync(path.join(app, 'frozen'))
    fs.writeFileSync(path.join(dir, 'outside.ts'), 'export const o = 1\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'outside')
    const r = await lintFixIn(app, ['frozen'], () => g('mv', 'outside.ts', 'app/frozen/b.ts'))
    expect(r.class).toBe('frozen-path')
    expect(fs.readFileSync(path.join(dir, 'outside.ts'), 'utf8')).toBe('export const o = 1\n')
    expect(g('status', '--porcelain')).toBe('')
})

// A copy's source still exists, so checking it out from HEAD discards its own edit.
test('the lint-fix frozen guard leaves the edited source of a copy into a frozen path alone', async () => {
    const {dir, app, g} = repo()
    g('config', 'status.renames', 'copies')
    const body = Array.from({length: 40}, (_, i) => `export const v${i} = ${i}\n`).join('')
    fs.mkdirSync(path.join(app, 'frozen'))
    fs.writeFileSync(path.join(dir, 'outside.ts'), body)
    g('add', '-A')
    g('commit', '-q', '-m', 'outside')
    fs.appendFileSync(path.join(dir, 'outside.ts'), 'export const task = 1\n')
    const r = await lintFixIn(app, ['frozen'], () => {
        fs.copyFileSync(path.join(dir, 'outside.ts'), path.join(app, 'frozen', 'b.ts'))
        g('add', '-A')
    })
    expect(r.class).toBe('frozen-path')
    expect(fs.existsSync(path.join(app, 'frozen', 'b.ts'))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'outside.ts'), 'utf8')).toBe(
        `${body}export const task = 1\n`
    )
})

// A user's copy-detection config must not turn a copy into a rename in the guard's eye:
// the status.renames pin leaves the destination a plain add, so its surviving source
// stays out of the revert.
test('the lint-fix frozen guard spares a copy source under user diff.renames=copies', async () => {
    const {dir, app, g} = repo()
    g('config', 'diff.renames', 'copies')
    const body = Array.from({length: 40}, (_, i) => `export const v${i} = ${i}\n`).join('')
    fs.mkdirSync(path.join(app, 'frozen'))
    fs.writeFileSync(path.join(dir, 'outside.ts'), body)
    g('add', '-A')
    g('commit', '-q', '-m', 'outside')
    const r = await lintFixIn(app, ['frozen'], () => {
        fs.appendFileSync(path.join(dir, 'outside.ts'), 'export const child = 1\n')
        fs.copyFileSync(path.join(dir, 'outside.ts'), path.join(app, 'frozen', 'b.ts'))
        g('add', '-A')
    })
    expect(r.class).toBe('frozen-path')
    expect(fs.existsSync(path.join(app, 'frozen', 'b.ts'))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'outside.ts'), 'utf8')).toBe(
        `${body}export const child = 1\n`
    )
})

// Past the rename limit git stops pairing inexact renames, and every source would stay deleted.
test('the lint-fix frozen guard pairs renames past a user rename limit', async () => {
    const {dir, app, g} = repo()
    g('config', 'diff.renameLimit', '1')
    const body = Array.from({length: 40}, (_, i) => `export const v${i} = ${i}\n`).join('')
    fs.mkdirSync(path.join(app, 'frozen'))
    for (const n of ['x', 'y', 'z']) fs.writeFileSync(path.join(dir, `${n}.ts`), `${body}// ${n}\n`)
    g('add', '-A')
    g('commit', '-q', '-m', 'outside')
    const r = await lintFixIn(app, ['frozen'], () => {
        for (const n of ['x', 'y', 'z']) {
            g('mv', `${n}.ts`, `app/frozen/moved-${n}.ts`)
            fs.appendFileSync(path.join(app, 'frozen', `moved-${n}.ts`), '// child\n')
        }
        g('add', '-A')
    })
    expect(r.class).toBe('frozen-path')
    for (const n of ['x', 'y', 'z'])
        expect(fs.readFileSync(path.join(dir, `${n}.ts`), 'utf8')).toBe(`${body}// ${n}\n`)
    expect(g('status', '--porcelain')).toBe('')
})

// A cancel or a lock can stop the drop between its two steps.
test('a drop whose second step fails puts the first one back', async () => {
    const {app, g} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 3\n')
    await gitCommitAll(app, 'ENFORCE GUIDELINES')
    const failing = fakeSpawnByPrompt(() => ({stdout: '', exitCode: 1}))
    let moved = false
    let failed = false
    const spawnFn: SpawnFn = (cmd, args, opts) => {
        if (moved && !failed) {
            failed = true
            return failing(cmd, args, opts)
        }
        if (args[0] === 'restore' || args[0] === 'reset') moved = true
        return spawn(cmd, args, opts) as unknown as ReturnType<SpawnFn>
    }
    expect(await gitDropLastCommit(app, undefined, spawnFn)).toBe(false)
    expect(failed).toBe(true)
    expect(g('log', '-1', '--format=%s')).toBe('ENFORCE GUIDELINES')
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 3\n')
    expect(g('status', '--porcelain')).toBe('')
})
