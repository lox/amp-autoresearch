import { expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readSessionFile, sessionFilePath, writeSessionFile } from '../autoresearch'

test('session round trip', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-auto-'))
	const s = {
		version: 1 as const,
		threadID: 'T-1',
		workdir: dir,
		active: true,
		autoResumeTurns: 2,
		activatedAt: 123,
	}
	writeSessionFile(dir, s)
	expect(readSessionFile(dir)).toEqual(s)
})
test('null for missing/corrupt/wrong shape', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-auto-'))
	expect(readSessionFile(dir)).toBeNull()
	fs.mkdirSync(path.dirname(sessionFilePath(dir)), { recursive: true })
	fs.writeFileSync(sessionFilePath(dir), 'bad')
	expect(readSessionFile(dir)).toBeNull()
	fs.writeFileSync(sessionFilePath(dir), JSON.stringify({ version: 2 }))
	expect(readSessionFile(dir)).toBeNull()
})
