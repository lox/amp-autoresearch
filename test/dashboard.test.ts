import { expect, test, afterEach } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { startDashboard, stopDashboard, logPath } from '../autoresearch'

let dir = ''
afterEach(() => stopDashboard(dir))

test('dashboard serves html, jsonl, sse, and 404', async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-dash-'))
	fs.mkdirSync(path.join(dir, '.auto'))
	fs.writeFileSync(
		logPath(dir),
		'{"type":"config","name":"Dash Test","metricName":"ms"}\n{"run":1,"commit":"abc","metric":5,"status":"keep","description":"d","timestamp":1}\n',
	)
	const url = startDashboard(dir)
	expect(startDashboard(dir)).toBe(url) // reused, not duplicated
	const html = await (await fetch(url)).text()
	expect(html).toContain('Dash Test')
	const jsonl = await (await fetch(url + 'autoresearch.jsonl')).text()
	expect(jsonl).toContain('"run":1')
	expect((await fetch(url + 'nope')).status).toBe(404)
	const sse = await fetch(url + 'events')
	expect(sse.headers.get('content-type')).toContain('text/event-stream')
	const reader = sse.body!.getReader()
	const first = new TextDecoder().decode((await reader.read()).value)
	expect(first).toContain('retry:')
	await reader.cancel()
})
