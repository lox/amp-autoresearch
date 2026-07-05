import { expect, test } from 'bun:test'
import * as fs from 'node:fs'
import {
	reconstructJsonlState,
	hasConfigHeader,
	extractSessionName,
	parseJsonlEntry,
	inferMetricUnit,
} from '../autoresearch'

test('reconstructs empty content defaults', () => {
	expect(reconstructJsonlState('')).toEqual({
		name: null,
		metricName: 'metric',
		metricUnit: '',
		bestDirection: 'lower',
		currentSegment: 0,
		results: [],
		secondaryMetrics: [],
	})
})

test('config-only header', () => {
	const jsonl =
		'{"type":"config","name":"S","metricName":"latency_ms","metricUnit":"ms","bestDirection":"higher"}\n'
	const s = reconstructJsonlState(jsonl)
	expect(hasConfigHeader(jsonl)).toBe(true)
	expect(extractSessionName(jsonl)).toBe('S')
	expect(s.metricName).toBe('latency_ms')
	expect(s.bestDirection).toBe('higher')
})

test('config and runs with defaults and asi passthrough', () => {
	const s = reconstructJsonlState(
		'{"type":"config","name":"A"}\n{"run":1,"asi":{"hypothesis":"h"}}\n',
	)
	expect(s.results[0]).toMatchObject({
		run: 1,
		commit: '',
		metric: 0,
		status: 'keep',
		description: '',
		timestamp: 0,
		segment: 0,
		confidence: null,
		asi: { hypothesis: 'h' },
	})
})

test('multi-segment config increments after results and resets secondary metrics', () => {
	const s = reconstructJsonlState(
		'{"type":"config","metricName":"a"}\n{"run":1,"metric":10,"metrics":{"foo_ms":1}}\n{"type":"config","metricName":"b"}\n{"run":2,"metric":9,"metrics":{"bar_kb":2}}\n',
	)
	expect(s.currentSegment).toBe(1)
	expect(s.results.map((r) => r.segment)).toEqual([0, 1])
	expect(s.secondaryMetrics).toEqual([{ name: 'bar_kb', unit: 'kb' }])
})

test('malformed lines skipped and helpers', () => {
	expect(parseJsonlEntry('nope')).toBeNull()
	const s = reconstructJsonlState('bad\n[]\n{"run":1,"metric":2}\n')
	expect(s.results).toHaveLength(1)
	expect(inferMetricUnit('x_µs')).toBe('µs')
	expect(inferMetricUnit('x_sec')).toBe('s')
})

test('realistic pi fixture reconstructs fully', () => {
	const text = fs.readFileSync('test/fixtures/pi-log.jsonl', 'utf-8')
	const s = reconstructJsonlState(text)
	expect(s.name).toBe('Optimizing parser')
	expect(s.metricName).toBe('total_µs')
	expect(s.results).toHaveLength(6)
	expect(s.results.map((r) => r.status)).toEqual([
		'keep',
		'keep',
		'discard',
		'crash',
		'keep',
		'discard',
	])
	expect(s.secondaryMetrics).toEqual([
		{ name: 'parse_µs', unit: 'µs' },
		{ name: 'alloc_mb', unit: 'mb' },
	])
	expect(s.results[1]?.asi?.hypothesis).toBe('cache parser')
})
