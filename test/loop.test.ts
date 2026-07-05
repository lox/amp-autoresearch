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
