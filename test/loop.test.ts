import { expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
	bindThreadSession,
	composeResumeMessage,
	decideContinue,
	deactivateSession,
	logPath,
	readSessionFile,
	resetRuntimesForTest,
	sessionForThread,
	turnLoggedExperiment,
	writeSessionFile,
	type AmpSession,
} from '../autoresearch'

function workdirWithSession(threadID: string, overrides: Partial<AmpSession> = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-loop-'))
	const session: AmpSession = {
		version: 1,
		threadID,
		workdir: dir,
		active: true,
		autoResumeTurns: 0,
		activatedAt: Date.now(),
		...overrides,
	}
	writeSessionFile(dir, session)
	fs.writeFileSync(
		logPath(dir),
		'{"type":"config","name":"S","metricName":"ms","metricUnit":"ms","bestDirection":"lower"}\n' +
			'{"run":1,"commit":"abc1234","metric":100,"metrics":{},"status":"keep","description":"baseline","timestamp":1,"confidence":null}\n',
	)
	return { dir, session }
}

test('decideContinue continues with a self-contained resume message', () => {
	const { dir, session } = workdirWithSession('T-1')
	const d = decideContinue({
		session,
		workdir: dir,
		turnStatus: 'done',
		turnLoggedExperiment: true,
		maxTurns: 20,
	})
	expect(d.action).toBe('continue')
	expect(d.userMessage).toContain('Run the next iteration now.')
	expect(d.userMessage).toContain('<autoresearch-state>')
	expect(d.userMessage).toContain('baseline: 100ms')
})

test('decideContinue gates: cancelled/error turns, chat-only turns, inactive sessions', () => {
	const { dir, session } = workdirWithSession('T-1')
	const base = { session, workdir: dir, turnLoggedExperiment: true, maxTurns: 20 }
	expect(decideContinue({ ...base, turnStatus: 'cancelled' }).action).toBe('none')
	expect(decideContinue({ ...base, turnStatus: 'error' }).action).toBe('none')
	expect(decideContinue({ ...base, turnStatus: 'done', turnLoggedExperiment: false }).action).toBe(
		'none',
	)
	expect(
		decideContinue({
			...base,
			session: { ...session, active: false },
			turnStatus: 'done',
		}).action,
	).toBe('none')
})

test('decideContinue stops at cap and on stranded log', () => {
	const { dir, session } = workdirWithSession('T-1')
	expect(
		decideContinue({
			session: { ...session, autoResumeTurns: 20 },
			workdir: dir,
			turnStatus: 'done',
			turnLoggedExperiment: true,
			maxTurns: 20,
		}).action,
	).toBe('stop-cap')
	fs.rmSync(logPath(dir))
	expect(
		decideContinue({
			session,
			workdir: dir,
			turnStatus: 'done',
			turnLoggedExperiment: true,
			maxTurns: 20,
		}).action,
	).toBe('stop-stranded')
})

test('turnLoggedExperiment detects completed log_experiment calls only', () => {
	expect(turnLoggedExperiment([])).toBe(false)
	expect(
		turnLoggedExperiment([{ call: { tool: 'run_experiment' }, result: { status: 'done' } }]),
	).toBe(false)
	expect(
		turnLoggedExperiment([{ call: { tool: 'log_experiment' }, result: { status: 'error' } }]),
	).toBe(false)
	expect(
		turnLoggedExperiment([{ call: { tool: 'log_experiment' }, result: { status: 'done' } }]),
	).toBe(true)
})

test('sessionForThread survives plugin reload via bindings index, never leaks to other threads', () => {
	const { dir } = workdirWithSession('T-owner')
	bindThreadSession('T-owner', dir)
	resetRuntimesForTest() // simulate plugin reload: in-memory state gone
	const found = sessionForThread('T-owner')
	expect(found?.workdir).toBe(dir)
	expect(sessionForThread('T-intruder')).toBeNull()
	deactivateSession(dir)
	resetRuntimesForTest()
	expect(sessionForThread('T-owner')).toBeNull()
	expect(readSessionFile(dir)?.active).toBe(false)
})

test('resume message round-trips the structural detector after reload', () => {
	const msg = composeResumeMessage('digest')
	expect(msg.startsWith('Run the next iteration now.')).toBe(true)
})

test('kickoff prompts embed workdir, tool contract, and loop rules', async () => {
	const { buildCreateKickoff, buildResumeKickoff } = await import('../autoresearch')
	const create = buildCreateKickoff('make parsing faster', '/repo')
	expect(create).toContain('make parsing faster')
	expect(create).toContain('working_dir set to the workspace root (/repo)')
	expect(create).toContain('.auto/measure.sh')
	expect(create).toContain('NEVER STOP')
	expect(create).toContain('.auto/amp-session.json')
	const resume = buildResumeKickoff('/repo')
	expect(resume).toContain('Resume the autoresearch experiment loop in /repo')
	expect(resume).toContain('working_dir=/repo')
	expect(resume).toContain('NEVER STOP')
})

test('final review fires once at session end with kept runs, suppressed on explicit stop', async () => {
	const { buildFinalReviewMessage, decideFinalReview, deactivateSession, readSessionFile } =
		await import('../autoresearch')
	const { dir, session } = workdirWithSession('T-1')
	const base = {
		session,
		keptCount: 2,
		turnStatus: 'done' as const,
		turnLoggedExperiment: true,
		enabled: true,
	}
	expect(decideFinalReview(base)).toBe(true)
	expect(decideFinalReview({ ...base, session: { ...session, finalReviewSent: true } })).toBe(false)
	expect(decideFinalReview({ ...base, keptCount: 0 })).toBe(false)
	expect(decideFinalReview({ ...base, turnStatus: 'cancelled' })).toBe(false)
	expect(decideFinalReview({ ...base, turnLoggedExperiment: false })).toBe(false)
	expect(decideFinalReview({ ...base, enabled: false })).toBe(false)
	// Explicit stop suppresses the review permanently.
	deactivateSession(dir, { suppressFinalReview: true })
	const after = readSessionFile(dir)!
	expect(after.active).toBe(false)
	expect(after.finalReviewSent).toBe(true)
})

test('final review message lists kept commits and forbids new experiments', async () => {
	const { buildFinalReviewMessage, reconstructJsonlState } = await import('../autoresearch')
	const state = reconstructJsonlState(
		'{"type":"config","name":"S","metricName":"tti_ms","metricUnit":"ms"}\n' +
			'{"run":1,"commit":"aaa1111","metric":100,"status":"keep","description":"baseline","timestamp":1}\n' +
			'{"run":2,"commit":"bbb2222","metric":60,"status":"keep","description":"big win","timestamp":2}\n' +
			'{"run":3,"commit":"ccc3333","metric":80,"status":"discard","description":"nope","timestamp":3}\n',
	)
	const msg = buildFinalReviewMessage(state, '/repo')
	expect(msg).toContain('Do NOT run more experiments')
	expect(msg).toContain('consult the oracle')
	expect(msg).toContain('bbb2222')
	expect(msg).toContain('-40.0%')
	expect(msg).not.toContain('ccc3333')
	expect(msg).toContain('Do not revert anything without')
})

test('probe runs are tallied separately in the digest', async () => {
	const { buildDigest, reconstructJsonlState } = await import('../autoresearch')
	const state = reconstructJsonlState(
		'{"type":"config","name":"S","metricName":"ms","metricUnit":"ms"}\n' +
			'{"run":1,"commit":"a","metric":100,"status":"keep","description":"base","timestamp":1}\n' +
			'{"run":2,"commit":"b","metric":100,"status":"discard","description":"instrument","timestamp":2,"asi":{"kind":"probe"}}\n' +
			'{"run":3,"commit":"c","metric":110,"status":"discard","description":"worse","timestamp":3}\n',
	)
	const d = buildDigest(state)
	expect(d).toContain('runs: 3 (1 keep, 1 discard, 0 crash, 1 probe)')
})

test('kickoff includes probe convention and default iteration budget', async () => {
	const { buildCreateKickoff } = await import('../autoresearch')
	const k = buildCreateKickoff('goal', '/repo')
	expect(k).toContain('asi: {kind: "probe"')
	expect(k).toContain('"maxIterations": 30')
	expect(k).toContain('probes don\x27t count')
	expect(k).toContain('amp-inflight.json')
})

test('inflight marker readable, stale-guarded, and cleared by run_experiment', async () => {
	const fsMod = await import('node:fs')
	const osMod = await import('node:os')
	const pathMod = await import('node:path')
	const { inflightPath, readInflight } = await import('../autoresearch')
	const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'ar-inflight-'))
	fsMod.mkdirSync(pathMod.join(dir, '.auto'))
	expect(readInflight(dir)).toBeNull()
	fsMod.writeFileSync(inflightPath(dir), JSON.stringify({ startedAt: Date.now() }))
	expect(readInflight(dir)).not.toBeNull()
	fsMod.writeFileSync(inflightPath(dir), JSON.stringify({ startedAt: Date.now() - 60 * 60 * 1000 }))
	expect(readInflight(dir)).toBeNull() // stale markers don't block forever
})
