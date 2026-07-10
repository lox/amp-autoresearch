import { expect, test, beforeEach } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
	bindThreadSession,
	checkSecondaryMetrics,
	executeRun,
	executeStartAutoresearch,
	gitHead,
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
	// Binding alone is not ownership: the session file must name this thread.
	expect(await executeRun({}, ctx)).toContain('no longer holds')
	const { writeSessionFile } = await import('../autoresearch')
	writeSessionFile(dir, {
		version: 1,
		threadID: 'T-test',
		workdir: dir,
		active: false,
		autoResumeTurns: 0,
		activatedAt: Date.now(),
		finalReviewSent: true,
	})
	const ended = await executeRun({}, ctx)
	expect(ended).toContain('already ended')
	expect(ended).not.toContain('init_experiment')
	writeSessionFile(dir, {
		version: 1,
		threadID: 'T-test',
		workdir: dir,
		active: true,
		autoResumeTurns: 0,
		activatedAt: Date.now(),
	})
	expect(await executeRun({}, ctx)).toContain('Missing .auto/measure.sh')
	fs.mkdirSync(path.join(dir, '.auto'), { recursive: true })
	fs.writeFileSync(path.join(dir, '.auto', 'measure.sh'), 'echo METRIC x=1\n')
	const out = await executeRun({}, ctx)
	expect(out).toContain('✅ PASSED')
	expect(out).toContain('x=1')
})

test('start_autoresearch launches a new thread with PR metadata', async () => {
	const dir = repo()
	execFileSync('git', ['checkout', '-b', 'feature/pr'], { cwd: dir })
	const messages: string[] = []
	let createOptions: { show?: boolean; parentThreadID?: string } | null = null
	const out = await executeStartAutoresearch(
		{
			goal: 'speed up this PR',
			working_dir: dir,
			max_iterations: 12,
			purpose: 'pr_optimization',
		},
		ctx,
		{
			ampURL: new URL('https://ampcode.com'),
			createThread: async (options) => {
				createOptions = options
				return {
					id: 'T-child',
					appendUserMessage: async (message) => {
						messages.push(message.content)
					},
				}
			},
		},
	)
	expect(out).toContain('[T-child](https://ampcode.com/threads/T-child)')
	expect(createOptions).not.toBeNull()
	expect(createOptions!).toEqual({ show: true, parentThreadID: 'T-test' })
	expect(messages.length).toBe(1)
	expect(messages[0]).toContain('speed up this PR')
	expect(messages[0]).toContain('PR optimisation context')
	expect(messages[0]).toContain('"maxIterations": 12')
	expect(messages[0]).toContain('"purpose": "pr_optimization"')
	expect(messages[0]).toContain('"baseBranch": "feature/pr"')
	expect(messages[0]).toContain((await gitHead(dir))!)
})

test('start_autoresearch can queue in the current thread or return a resume prompt', async () => {
	const dir = repo()
	const queued: Array<{ content: string; steer?: boolean }> = []
	const out = await executeStartAutoresearch(
		{ goal: 'make it faster', working_dir: dir, target: 'current_thread' },
		{
			...ctx,
			thread: {
				...ctx.thread,
				appendUserMessage: async (message, options) => {
					queued.push({ content: message.content, steer: options?.steer })
				},
			},
		},
	)
	expect(out).toContain('queued in this thread')
	expect(queued).toHaveLength(1)
	expect(queued[0]!.steer).toBe(true)
	expect(queued[0]!.content).toContain('make it faster')

	fs.mkdirSync(path.join(dir, '.auto'), { recursive: true })
	fs.writeFileSync(path.join(dir, '.auto', 'prompt.md'), '# existing session\n')
	const prompt = await executeStartAutoresearch({ working_dir: dir, target: 'return_prompt' }, ctx)
	expect(prompt).toContain('Resume the autoresearch experiment loop')
})

test('start_autoresearch refuses dirty worktrees before launching a new session', async () => {
	const dir = repo()
	fs.writeFileSync(path.join(dir, 'tracked.txt'), 'dirty\n')
	let created = false
	const out = await executeStartAutoresearch({ goal: 'make it faster', working_dir: dir }, ctx, {
		createThread: async () => {
			created = true
			return {
				id: 'T-child',
				appendUserMessage: async () => {},
			}
		},
	})
	expect(out).toContain('Working tree is dirty')
	expect(created).toBe(false)
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

test('init refuses foreign active session without confirm, takes over with confirm', async () => {
	const { executeInit, readSessionFile } = await import('../autoresearch')
	const dir = repo()
	execFileSync('git', ['checkout', '-b', 'autoresearch/test'], { cwd: dir })
	const yes = { ...ctx, ui: { confirm: async () => true } }
	await executeInit({ working_dir: dir, name: 'T', metric_name: 'ms' }, yes)
	// A second thread with a declining user is refused
	const otherNo = {
		ui: { confirm: async () => false },
		thread: { ...ctx.thread, id: 'T-other' },
	}
	expect(await executeInit({ working_dir: dir, name: 'T', metric_name: 'ms' }, otherNo)).toContain(
		'held by thread T-test',
	)
	expect(readSessionFile(dir)?.threadID).toBe('T-test')
	// With confirmation the session transfers
	const otherYes = {
		ui: { confirm: async () => true },
		thread: { ...ctx.thread, id: 'T-other' },
	}
	expect(await executeInit({ working_dir: dir, name: 'T', metric_name: 'ms' }, otherYes)).toContain(
		'✅',
	)
	expect(readSessionFile(dir)?.threadID).toBe('T-other')
})

test('stale binding after takeover refuses run/log (ownership re-validation)', async () => {
	const { executeInit, executeRun, executeLog } = await import('../autoresearch')
	const dir = repo()
	execFileSync('git', ['checkout', '-b', 'autoresearch/test'], { cwd: dir })
	fs.mkdirSync(path.join(dir, '.auto'), { recursive: true })
	fs.writeFileSync(path.join(dir, '.auto', 'measure.sh'), 'echo METRIC x=1\n')
	const yes = { ...ctx, ui: { confirm: async () => true } }
	await executeInit({ working_dir: dir, name: 'T', metric_name: 'ms' }, yes)
	// Another thread takes over; T-test's in-memory binding is now stale.
	const otherYes = {
		ui: { confirm: async () => true },
		thread: { ...ctx.thread, id: 'T-other' },
	}
	await executeInit({ working_dir: dir, name: 'T', metric_name: 'ms' }, otherYes)
	expect(await executeRun({}, ctx)).toContain('no longer holds')
	expect(
		await executeLog({ commit: 'abc1234', metric: 1, status: 'discard', description: 'x' }, ctx),
	).toContain('no longer holds')
})

test('probe metrics are ephemeral: no force-dance around instrumentation fields', async () => {
	const { executeInit, executeLog, establishedSecondaryMetrics, reconstructJsonlState, logPath } =
		await import('../autoresearch')
	const dir = repo()
	execFileSync('git', ['checkout', '-b', 'autoresearch/test'], { cwd: dir })
	const yes = { ...ctx, ui: { confirm: async () => true } }
	await executeInit({ working_dir: dir, name: 'T', metric_name: 'ms' }, yes)
	// Baseline establishes one secondary metric.
	expect(
		await executeLog(
			{
				commit: 'aaaaaaa',
				metric: 100,
				status: 'keep',
				description: 'base',
				metrics: { p95: 120 },
			},
			ctx,
		),
	).toContain('✅ kept')
	// A probe reports extra instrumentation fields — no force needed, and it
	// doesn't have to include the established p95 either.
	expect(
		await executeLog(
			{
				commit: 'bbbbbbb',
				metric: 100,
				status: 'discard',
				description: 'instrumented re-measure',
				metrics: { backend_run_ms: 31, tail_ms: 2 },
				asi: { kind: 'probe', learned: 'attribution' },
			},
			ctx,
		),
	).toContain('discarded')
	// The probe's fields did NOT join the tracked set...
	const state = reconstructJsonlState(fs.readFileSync(logPath(dir), 'utf-8'))
	expect(establishedSecondaryMetrics(state).sort()).toEqual(['p95'])
	// ...so the next normal run only owes p95 (no force), and still gets
	// refused if it drops the genuinely tracked metric.
	expect(
		await executeLog(
			{ commit: 'ccccccc', metric: 90, status: 'keep', description: 'win', metrics: { p95: 110 } },
			ctx,
		),
	).toContain('✅ kept')
	expect(
		await executeLog(
			{ commit: 'ddddddd', metric: 85, status: 'keep', description: 'drop', metrics: {} },
			ctx,
		),
	).toContain('Missing secondary metrics: p95')
})

test('first tracked run defines the secondary-metric set without force', async () => {
	const { checkSecondaryMetrics } = await import('../autoresearch')
	expect(checkSecondaryMetrics([], { p95: 1, mem_kb: 2 })).toEqual({ ok: true })
})

test('conclude_experiment refuses unbound, checks ownership, claims the final review once', async () => {
	const { executeConclude, writeSessionFile, readSessionFile, logPath } =
		await import('../autoresearch')
	expect(await executeConclude({ reason: 'done' }, ctx)).toContain('No experiment session')
	const dir = repo()
	bindThreadSession('T-test', dir)
	expect(await executeConclude({ reason: 'done' }, ctx)).toContain('no longer holds')
	writeSessionFile(dir, {
		version: 1,
		threadID: 'T-test',
		workdir: dir,
		active: true,
		autoResumeTurns: 0,
		activatedAt: Date.now(),
	})
	fs.writeFileSync(
		logPath(dir),
		'{"type":"config","name":"S","metricName":"ms","metricUnit":"ms","bestDirection":"lower"}\n' +
			'{"run":1,"commit":"abc1234","metric":100,"metrics":{},"status":"keep","description":"baseline","timestamp":1,"confidence":null}\n',
	)
	const out = await executeConclude({ reason: 'target met' }, ctx)
	expect(out).toContain('Session concluded — target met')
	expect(out).toContain('pressure-test the kept experiments with the oracle')
	const after = readSessionFile(dir)!
	expect(after.active).toBe(false)
	expect(after.finalReviewSent).toBe(true)
	// Second conclude is idempotent: no double-send, no rebind suggestion.
	const again = await executeConclude({ reason: 'again' }, ctx)
	expect(again).toContain('Session already concluded')
	expect(again).not.toContain('init_experiment')
})

test('conclude_experiment deactivates cleanly when there is nothing to review', async () => {
	const { executeConclude, writeSessionFile, readSessionFile } = await import('../autoresearch')
	const dir = repo()
	bindThreadSession('T-test', dir)
	writeSessionFile(dir, {
		version: 1,
		threadID: 'T-test',
		workdir: dir,
		active: true,
		autoResumeTurns: 0,
		activatedAt: Date.now(),
	})
	// No .auto/log.jsonl → no kept experiments → no review, but a clean stop.
	const out = await executeConclude({ reason: 'ideas exhausted' }, ctx)
	expect(out).toContain('Session concluded — ideas exhausted')
	expect(out).toContain('No kept experiments to review')
	const after = readSessionFile(dir)!
	expect(after.active).toBe(false)
	expect(after.finalReviewSent).toBe(true)
})
