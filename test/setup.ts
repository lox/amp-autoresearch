import { beforeEach } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { setBindingsFileForTest, resetRuntimesForTest } from '../autoresearch'

beforeEach(() => {
	resetRuntimesForTest()
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-bindings-'))
	setBindingsFileForTest(path.join(dir, 'bindings.json'))
})
