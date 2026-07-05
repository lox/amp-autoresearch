import { expect, test } from 'bun:test'
import { computeConfidence, type Run } from '../autoresearch'
const r = (metric: number, status: Run['status'] = 'keep', segment = 0): Run => ({
	run: 1,
	commit: '',
	metric,
	metrics: {},
	status,
	description: '',
	timestamp: 0,
	segment,
	confidence: null,
})

test('null when fewer than 3 positive runs', () =>
	expect(computeConfidence([r(100), r(90)], 0, 'lower')).toBeNull())
test('null when MAD is zero', () =>
	expect(computeConfidence([r(100), r(100), r(100)], 0, 'lower')).toBeNull())
test('null when no kept improvement', () =>
	expect(computeConfidence([r(100), r(90, 'discard'), r(95, 'discard')], 0, 'lower')).toBeNull())
test('hand-computed lower case', () =>
	expect(computeConfidence([r(100), r(90), r(95, 'discard'), r(92, 'discard')], 0, 'lower')).toBe(
		4,
	))
test('higher direction case', () =>
	expect(
		computeConfidence([r(100), r(110), r(105, 'discard'), r(108, 'discard')], 0, 'higher'),
	).toBe(4))
test('metric <= 0 excluded', () =>
	expect(
		computeConfidence([r(100), r(90), r(0, 'crash'), r(-1, 'discard')], 0, 'lower'),
	).toBeNull())
