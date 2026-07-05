import { expect, test } from 'bun:test'
import { commas, formatDelta, formatElapsed, formatNum, formatRunLine } from '../autoresearch'

test('number formatting', () => {
	expect(commas(15586)).toBe('15,586')
	expect(formatNum(1234.567, 'ms')).toBe('1,234.57ms')
	expect(formatNum(null, '')).toBe('—')
})
test('elapsed', () => {
	expect(formatElapsed(65000)).toBe('1m 05s')
	expect(formatElapsed(9000)).toBe('9s')
})
test('delta', () => {
	expect(formatDelta(90, null)).toBe('')
	expect(formatDelta(90, 0)).toBe('')
	expect(formatDelta(100, 100)).toBe('')
	expect(formatDelta(90, 100)).toBe(' (-10.0%)')
	expect(formatDelta(110, 100)).toBe(' (+10.0%)')
})
test('run line edge cases', () => {
	expect(
		formatRunLine(
			{
				run: 2,
				commit: '',
				metric: 90.125,
				metrics: {},
				status: 'discard',
				description: 'try x',
				timestamp: 0,
				segment: 0,
				confidence: null,
				asi: { hypothesis: ' h ', next_action_hint: ' n ', rollback_reason: ' r ' },
			},
			100,
		),
	).toBe('#2 discard       90.13 (-9.9%) | desc: try x | hyp: h | next: n | rollback: r')
})

test('resolveWorkDir tolerates non-string workingDir in config', async () => {
	const fs = await import('node:fs')
	const os = await import('node:os')
	const path = await import('node:path')
	const { resolveWorkDir } = await import('../autoresearch')
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-config-'))
	fs.mkdirSync(path.join(dir, '.auto'))
	fs.writeFileSync(path.join(dir, '.auto', 'config.json'), '{"workingDir": 123}')
	expect(resolveWorkDir(dir)).toBe(dir)
})
