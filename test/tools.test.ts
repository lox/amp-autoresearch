import { expect, test, beforeEach } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
	bindThreadSession,
	checkSecondaryMetrics,
	executeRun,
	gitCommitAll,
	gitIsDirty,
	gitRevertAll,
	resetRuntimesForTest,
	runHook,
	truncateExperimentOutput,
} from '../autoresearch'

beforeEach(() => resetRuntimesForTest())

function repo() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-tools-'))
	execFileSync('git', ['init'], { cwd: dir })
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
	fs.writeFileSync(path.join(dir, 'tracked.txt'), 'base\n')
	execFileSync('git', ['add', '.'], { cwd: dir })
	execFileSync('git', ['commit', '-m', 'base'], { cwd: dir })
	return dir
}
const ctx = {
	thread: {
		id: 'T-test',
		state: {
			get: async () => {
				throw new Error('no active thread')
			},
		},
	},
}

test('truncateExperimentOutput caps to 10 lines and 4KB', () => {
	const t = truncateExperimentOutput(Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n'))
	expect(t.truncated).toBe(true)
	expect(t.content).toContain('line19')
	expect(t.content).not.toContain('line0')
	expect(Buffer.byteLength(truncateExperimentOutput('x'.repeat(5000)).content)).toBeLessThanOrEqual(
		4096,
	)
})

test('checkSecondaryMetrics enforces missing and new names', () => {
	expect(checkSecondaryMetrics(['a'], {})).toEqual({ error: 'Missing secondary metrics: a' })
	expect(checkSecondaryMetrics(['a'], { a: 1, b: 2 })).toEqual({
		error: 'New secondary metric not previously tracked: b. Use force:true only if valuable.',
	})
	expect(checkSecondaryMetrics(['a'], { a: 1, b: 2 }, true)).toEqual({ ok: true })
})

test('git helpers commit and revert while preserving .auto', async () => {
	const dir = repo()
	fs.writeFileSync(path.join(dir, 'tracked.txt'), 'dirty\n')
	expect(await gitIsDirty(dir)).toBe(true)
	fs.mkdirSync(path.join(dir, '.auto'))
	fs.writeFileSync(path.join(dir, '.auto', 'log.jsonl'), 'keep\n')
	fs.writeFileSync(path.join(dir, 'junk.txt'), 'junk\n')
	await gitRevertAll(dir)
	expect(fs.readFileSync(path.join(dir, 'tracked.txt'), 'utf-8')).toBe('base\n')
	expect(fs.existsSync(path.join(dir, 'junk.txt'))).toBe(false)
	expect(fs.existsSync(path.join(dir, '.auto', 'log.jsonl'))).toBe(true)
	fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n')
	const c = await gitCommitAll(dir, 'new')
	expect(c.ok).toBe(true)
	if (c.ok) expect(c.sha).toMatch(/^[0-9a-f]{7}$/)
})

test('hook runner skips non-executable and captures stdin/stdout', async () => {
	const dir = repo()
	fs.mkdirSync(path.join(dir, '.auto', 'hooks'), { recursive: true })
	const script = path.join(dir, '.auto', 'hooks', 'before.sh')
	fs.writeFileSync(script, 'cat > payload.json\necho hello\n')
	expect((await runHook({ event: 'before', cwd: dir })).fired).toBe(false)
	fs.chmodSync(script, 0o755)
	const r = await runHook({ event: 'before', cwd: dir, next_run: 1 })
	expect(r.fired).toBe(true)
	expect(r.stdout.trim()).toBe('hello')
	expect(JSON.parse(fs.readFileSync(path.join(dir, 'payload.json'), 'utf-8')).next_run).toBe(1)
})

test('run_experiment refuses unbound/missing and parses real measure.sh', async () => {
	expect(await executeRun({}, ctx)).toContain('No experiment session')
	const dir = repo()
	bindThreadSession('T-test', dir)
	expect(await executeRun({}, ctx)).toContain('Missing .auto/measure.sh')
	fs.mkdirSync(path.join(dir, '.auto'), { recursive: true })
	fs.writeFileSync(path.join(dir, '.auto', 'measure.sh'), 'echo METRIC x=1\n')
	const out = await executeRun({}, ctx)
	expect(out).toContain('✅ PASSED')
	expect(out).toContain('x=1')
})

test('log_experiment refuses invalid status and non-finite metric', async () => {
	const { executeLog, executeInit } = await import('../autoresearch')
	const dir = repo()
	execFileSync('git', ['checkout', '-b', 'autoresearch/test'], { cwd: dir })
	const initCtx = { ...ctx, ui: { confirm: async () => true } }
	const initOut = await executeInit({ working_dir: dir, name: 'T', metric_name: 'ms' }, initCtx)
	expect(initOut).toContain('✅')
	expect(
		await executeLog({ commit: 'abc1234', metric: 1, status: 'kept', description: 'x' }, ctx),
	).toContain('Invalid status')
	expect(
		await executeLog({ commit: 'abc1234', metric: 'oops', status: 'keep', description: 'x' }, ctx),
	).toContain('finite number')
})

test('log_experiment keep commits then appends jsonl with post-commit sha; discard reverts', async () => {
	const { executeLog, executeInit, logPath } = await import('../autoresearch')
	const fsMod = await import('node:fs')
	const pathMod = await import('node:path')
	const dir = repo()
	execFileSync('git', ['checkout', '-b', 'autoresearch/test'], { cwd: dir })
	const initCtx = { ...ctx, ui: { confirm: async () => true } }
	await executeInit({ working_dir: dir, name: 'T', metric_name: 'ms' }, initCtx)
	fsMod.writeFileSync(pathMod.join(dir, 'tracked.txt'), 'improved\n')
	const keep = await executeLog(
		{ commit: '0000000', metric: 90, status: 'keep', description: 'improvement' },
		ctx,
	)
	expect(keep).toContain('✅ kept')
	expect(keep).toContain('Git: committed')
	const lastLine = fsMod.readFileSync(logPath(dir), 'utf-8').trim().split('\n').at(-1)!
	const entry = JSON.parse(lastLine)
	expect(entry.commit).toMatch(/^[0-9a-f]{7}$/)
	expect(entry.commit).not.toBe('0000000')
	// discard reverts tracked changes
	fsMod.writeFileSync(pathMod.join(dir, 'tracked.txt'), 'regressed\n')
	const discard = await executeLog(
		{ commit: entry.commit, metric: 120, status: 'discard', description: 'worse' },
		ctx,
	)
	expect(discard).toContain('↩️ discarded')
	expect(fsMod.readFileSync(pathMod.join(dir, 'tracked.txt'), 'utf-8')).toBe('improved\n')
})

test('init refuses dirty worktree and resumes without duplicate header', async () => {
	const { executeInit, logPath } = await import('../autoresearch')
	const fsMod = await import('node:fs')
	const pathMod = await import('node:path')
	const dir = repo()
	execFileSync('git', ['checkout', '-b', 'autoresearch/test'], { cwd: dir })
	const initCtx = { ...ctx, ui: { confirm: async () => true } }
	fsMod.writeFileSync(pathMod.join(dir, 'tracked.txt'), 'dirty\n')
	expect(await executeInit({ working_dir: dir, name: 'T', metric_name: 'ms' }, initCtx)).toContain(
		'dirty',
	)
	execFileSync('git', ['checkout', '--', '.'], { cwd: dir })
	await executeInit({ working_dir: dir, name: 'T', metric_name: 'ms' }, initCtx)
	await executeInit({ working_dir: dir, name: 'T', metric_name: 'ms' }, initCtx)
	const headers = fsMod
		.readFileSync(logPath(dir), 'utf-8')
		.trim()
		.split('\n')
		.filter((l: string) => l.includes('"type":"config"'))
	expect(headers.length).toBe(1)
})
