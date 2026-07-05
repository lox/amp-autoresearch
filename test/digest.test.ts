import { expect, test } from 'bun:test'
import { buildDigest, type Run, type SessionState } from '../autoresearch'
const run = (n: number, metric: number, status: Run['status'], segment = 0): Run => ({
	run: n,
	commit: '',
	metric,
	metrics: {},
	status,
	description: `r${n}`,
	timestamp: 0,
	segment,
	confidence: null,
})
const state = (results: Run[], currentSegment = 0): SessionState => ({
	name: 'S',
	metricName: 'total_µs',
	metricUnit: 'µs',
	bestDirection: 'lower',
	currentSegment,
	results,
	secondaryMetrics: [],
})

test('empty digest', () =>
	expect(buildDigest(state([]))).toContain('runs: 0 — no experiments yet; take a baseline first.'))
test('populated digest counts best delta and confidence', () => {
	const d = buildDigest(
		state([
			run(1, 100, 'keep'),
			run(2, 90, 'keep'),
			run(3, 95, 'discard'),
			run(4, 92, 'discard'),
			run(5, 0, 'crash'),
		]),
		{ recentRuns: 10 },
	)
	expect(d).toContain('runs: 5 (2 keep, 2 discard, 1 crash)')
	expect(d).toContain('baseline: 100µs | best: 90µs (-10.0%) | confidence: 4.0×')
})
test('confidence omitted when null', () =>
	expect(buildDigest(state([run(1, 100, 'keep')]))).not.toContain('confidence:'))
test('recent limited to 3 and current segment only', () => {
	const d = buildDigest(
		state(
			[
				run(1, 100, 'keep', 0),
				run(2, 99, 'keep', 0),
				run(3, 50, 'keep', 1),
				run(4, 40, 'keep', 1),
				run(5, 45, 'discard', 1),
				run(6, 42, 'discard', 1),
			],
			1,
		),
	)
	expect(d).not.toContain('#1')
	expect(d).not.toContain('#3')
	expect(d).toContain('#4')
	expect(d).toContain('#6')
})
