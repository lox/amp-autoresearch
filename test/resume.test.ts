import { expect, test } from 'bun:test'
import { composeResumeMessage, isResumeMessage } from '../autoresearch'

test('compose output is structurally recognized', () =>
	expect(isResumeMessage(composeResumeMessage('digest'))).toBe(true))
test('ordinary text false', () => expect(isResumeMessage('hello')).toBe(false))
test('tag mid-message but wrong start false', () =>
	expect(isResumeMessage('hello <autoresearch-state>')).toBe(false))
