import { expect, test } from 'bun:test'
import { parseMetricLines } from '../autoresearch'

test('parseMetricLines basic names', () => {
	const m = parseMetricLines('METRIC total=1\nMETRIC total_µs=2\nMETRIC a.b=3\n')
	expect([...m.entries()]).toEqual([
		['total', 1],
		['total_µs', 2],
		['a.b', 3],
	])
})
test('denies prototype pollution names', () =>
	expect(
		parseMetricLines('METRIC __proto__=1\nMETRIC constructor=2\nMETRIC prototype=3\n').size,
	).toBe(0))
test('rejects invalid numbers', () =>
	expect(parseMetricLines('METRIC a=Infinity\nMETRIC b=NaN\nMETRIC c=nope\n').size).toBe(0))
test('last wins duplicates', () =>
	expect(parseMetricLines('METRIC x=1\nMETRIC x=2\n').get('x')).toBe(2))
test('ignores non-metric and indented lines', () =>
	expect(parseMetricLines('x METRIC a=1\n METRIC b=2\nMETRIC c=3\n').has('b')).toBe(false))
