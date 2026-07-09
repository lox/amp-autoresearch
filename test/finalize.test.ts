import { expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

const finalizeScript = path.resolve(
	import.meta.dir,
	'..',
	'skills',
	'autoresearch-finalize',
	'finalize.sh',
)

function git(dir: string, args: string[]): string {
	return execFileSync('git', args, {
		cwd: dir,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim()
}

function repo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-finalize-'))
	git(dir, ['init'])
	git(dir, ['config', 'user.email', 'test@example.com'])
	git(dir, ['config', 'user.name', 'Test'])
	fs.writeFileSync(path.join(dir, 'app.txt'), 'main\n')
	git(dir, ['add', '.'])
	git(dir, ['commit', '-m', 'main base'])
	git(dir, ['branch', '-m', 'main'])
	return dir
}

function writeGroupsFile(dir: string, config: unknown): string {
	const file = path.join(dir, 'groups.json')
	fs.writeFileSync(file, JSON.stringify(config, null, 2))
	return file
}

test('finalize creates PR optimisation branches from the recorded base commit', () => {
	const dir = repo()
	git(dir, ['checkout', '-b', 'feature/pr'])
	fs.writeFileSync(path.join(dir, 'app.txt'), 'pr base\n')
	git(dir, ['commit', '-am', 'pr base'])
	const prBase = git(dir, ['rev-parse', 'HEAD'])

	git(dir, ['checkout', '-b', 'ar-session'])
	fs.writeFileSync(path.join(dir, 'app.txt'), 'pr base\nfast path\n')
	git(dir, ['commit', '-am', 'optimise app'])
	const optimisationCommit = git(dir, ['rev-parse', 'HEAD'])

	const groups = writeGroupsFile(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-groups-')), {
		base: prBase,
		trunk: 'feature/pr',
		final_tree: optimisationCommit,
		goal: 'pr-opt',
		groups: [
			{
				title: 'Use fast path',
				body: 'Optimises the PR path.\n\nExperiments: #2\nMetric: wall_ms 10 → 7 (-30%)',
				last_commit: optimisationCommit,
				slug: 'fast-path',
			},
		],
	})

	execFileSync('bash', [finalizeScript, groups], {
		cwd: dir,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	const branch = 'autoresearch/pr-opt/01-fast-path'
	expect(git(dir, ['rev-parse', `${branch}^`])).toBe(prBase)
	expect(git(dir, ['show', `${branch}:app.txt`])).toBe('pr base\nfast path')
	expect(git(dir, ['diff', '--name-only', prBase, branch])).toBe('app.txt')
})

test('finalize rejects a base that is not an ancestor of the autoresearch branch', () => {
	const dir = repo()
	git(dir, ['checkout', '-b', 'ar-session'])
	fs.writeFileSync(path.join(dir, 'app.txt'), 'optimised\n')
	git(dir, ['commit', '-am', 'optimise app'])
	const finalTree = git(dir, ['rev-parse', 'HEAD'])

	git(dir, ['checkout', '--orphan', 'unrelated'])
	fs.rmSync(path.join(dir, 'app.txt'), { force: true })
	fs.writeFileSync(path.join(dir, 'other.txt'), 'other\n')
	git(dir, ['add', '-A'])
	git(dir, ['commit', '-m', 'unrelated base'])
	const unrelatedBase = git(dir, ['rev-parse', 'HEAD'])
	git(dir, ['checkout', 'ar-session'])

	const groups = writeGroupsFile(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-groups-')), {
		base: unrelatedBase,
		trunk: 'main',
		final_tree: finalTree,
		goal: 'bad-base',
		groups: [
			{
				title: 'Use fast path',
				body: 'Optimises the path.\n\nExperiments: #2\nMetric: wall_ms 10 → 7 (-30%)',
				last_commit: finalTree,
				slug: 'fast-path',
			},
		],
	})

	try {
		execFileSync('bash', [finalizeScript, groups], {
			cwd: dir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		throw new Error('expected finalize.sh to fail')
	} catch (e) {
		const stderr = String((e as { stderr?: Buffer | string }).stderr ?? '')
		expect(stderr).toContain('is not an ancestor')
	}
})
