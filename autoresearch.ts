import * as fs from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import type { PluginAPI } from '@ampcode/plugin'

const execFileAsync = promisify(execFile)

export type RunStatus = 'keep' | 'discard' | 'crash' | 'checks_failed'
export type BestDirection = 'lower' | 'higher'
export type JsonlEntry = Record<string, unknown>
export interface ConfigEntry extends JsonlEntry {
	type: 'config'
	name?: string
	metricName?: string
	metricUnit?: string
	bestDirection?: BestDirection
}
export interface RunEntry extends JsonlEntry {
	run: number
}
export interface MetricDef {
	name: string
	unit: string
}
export interface Run {
	run: number
	commit: string
	metric: number
	metrics: Record<string, number>
	status: RunStatus
	description: string
	timestamp: number
	segment: number
	confidence: number | null
	asi?: Record<string, unknown>
}
export interface SessionState {
	name: string | null
	metricName: string
	metricUnit: string
	bestDirection: BestDirection
	currentSegment: number
	results: Run[]
	secondaryMetrics: MetricDef[]
}
export interface AutoConfig {
	maxIterations?: number
	workingDir?: string
	maxAutoResumeTurns?: number
}
export interface AmpSession {
	version: 1
	threadID: string
	workdir: string
	active: boolean
	autoResumeTurns: number
	activatedAt: number
}

const DEFAULT_METRIC_NAME = 'metric'
const DEFAULT_METRIC_UNIT = ''
const DEFAULT_DIRECTION: BestDirection = 'lower'
export const DENIED_METRIC_NAMES = new Set(['__proto__', 'constructor', 'prototype'])
export const AUTO_DIR = '.auto'
export const DEFAULT_MAX_AUTO_RESUME_TURNS = 20
export const RESUME_PREAMBLE = 'Run the next iteration now.'
export const STATE_TAG = 'autoresearch-state'

function isObjectRecord(value: unknown): value is JsonlEntry {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function nonEmptyLines(text: string): string[] {
	return text.split('\n').filter(Boolean)
}
function metricMapFrom(value: unknown): Record<string, number> {
	if (!isObjectRecord(value)) return {}
	const out: Record<string, number> = {}
	for (const [k, v] of Object.entries(value)) if (typeof v === 'number') out[k] = v
	return out
}
function statusFrom(value: unknown): RunStatus {
	if (value === 'discard' || value === 'crash' || value === 'checks_failed') return value
	return 'keep'
}
function directionFrom(value: unknown): BestDirection {
	return value === 'higher' ? 'higher' : DEFAULT_DIRECTION
}
function asiFrom(value: unknown): Record<string, unknown> | undefined {
	return isObjectRecord(value) ? value : undefined
}
function initialState(): SessionState {
	return {
		name: null,
		metricName: DEFAULT_METRIC_NAME,
		metricUnit: DEFAULT_METRIC_UNIT,
		bestDirection: DEFAULT_DIRECTION,
		currentSegment: 0,
		results: [],
		secondaryMetrics: [],
	}
}
function updateConfig(state: SessionState, entry: ConfigEntry): void {
	if (typeof entry.name === 'string') state.name = entry.name
	if (typeof entry.metricName === 'string') state.metricName = entry.metricName
	if (typeof entry.metricUnit === 'string') state.metricUnit = entry.metricUnit
	state.bestDirection = directionFrom(entry.bestDirection)
}
function nextSegment(state: SessionState, segment: number): number {
	if (state.results.length === 0) return segment
	state.secondaryMetrics = []
	return segment + 1
}
function runFrom(entry: RunEntry, segment: number): Run {
	return {
		run: typeof entry.run === 'number' ? entry.run : 0,
		commit: typeof entry.commit === 'string' ? entry.commit : '',
		metric: typeof entry.metric === 'number' ? entry.metric : 0,
		metrics: metricMapFrom(entry.metrics),
		status: statusFrom(entry.status),
		description: typeof entry.description === 'string' ? entry.description : '',
		timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : 0,
		segment,
		confidence: typeof entry.confidence === 'number' ? entry.confidence : null,
		asi: asiFrom(entry.asi),
	}
}
function registerSecondaryMetrics(state: SessionState, metrics: Record<string, number>): void {
	for (const name of Object.keys(metrics))
		if (!state.secondaryMetrics.find((m) => m.name === name))
			state.secondaryMetrics.push({ name, unit: inferMetricUnit(name) })
}

/** Parse one JSONL line, returning null for malformed/non-object entries. */
export function parseJsonlEntry(line: string): JsonlEntry | null {
	try {
		const parsed: unknown = JSON.parse(line)
		return isObjectRecord(parsed) ? parsed : null
	} catch {
		return null
	}
}
/** True for pi-autoresearch config entries. */
export function isConfigEntry(entry: unknown): entry is ConfigEntry {
	return isObjectRecord(entry) && entry.type === 'config'
}
/** True for pi-autoresearch run entries. */
export function isRunEntry(entry: unknown): entry is RunEntry {
	return isObjectRecord(entry) && typeof entry.run === 'number'
}
function firstConfigEntry(jsonl: string): ConfigEntry | null {
	for (const line of nonEmptyLines(jsonl)) {
		const e = parseJsonlEntry(line)
		if (isConfigEntry(e)) return e
	}
	return null
}
/** Whether JSONL contains a config header. */
export function hasConfigHeader(jsonl: string): boolean {
	return firstConfigEntry(jsonl) !== null
}
/** Extract session name, defaulting to pi's Autoresearch label. */
export function extractSessionName(jsonl: string): string {
	return firstConfigEntry(jsonl)?.name || 'Autoresearch'
}
/** Infer display unit from a metric name suffix. */
export function inferMetricUnit(name: string): string {
	if (name.endsWith('µs')) return 'µs'
	if (name.endsWith('_ms')) return 'ms'
	if (name.endsWith('_s') || name.endsWith('_sec')) return 's'
	if (name.endsWith('_kb')) return 'kb'
	if (name.endsWith('_mb')) return 'mb'
	return ''
}
/** Reconstruct session state from append-only JSONL, skipping malformed lines. */
export function reconstructJsonlState(jsonl: string): SessionState {
	const state = initialState()
	let segment = 0
	for (const line of nonEmptyLines(jsonl)) {
		const entry = parseJsonlEntry(line)
		if (!entry) continue
		if (isConfigEntry(entry)) {
			updateConfig(state, entry)
			segment = nextSegment(state, segment)
			state.currentSegment = segment
			continue
		}
		if (!isRunEntry(entry)) continue
		const run = runFrom(entry, segment)
		state.results.push(run)
		registerSecondaryMetrics(state, run.metrics)
	}
	return state
}

/** Parse line-anchored METRIC name=value output; finite numbers only, last wins. */
export function parseMetricLines(output: string): Map<string, number> {
	const metrics = new Map<string, number>()
	const regex = /^METRIC\s+([\w.µ]+)=(\S+)\s*$/gm
	let match: RegExpExecArray | null
	while ((match = regex.exec(output)) !== null) {
		const name = match[1]!
		if (DENIED_METRIC_NAMES.has(name)) continue
		const value = Number(match[2])
		if (Number.isFinite(value)) metrics.set(name, value)
	}
	return metrics
}
/** Direction-aware comparison. */
export function isBetter(current: number, best: number, direction: BestDirection): boolean {
	return direction === 'lower' ? current < best : current > best
}
/** Median of a numeric array; returns 0 for empty arrays. */
export function sortedMedian(values: number[]): number {
	if (values.length === 0) return 0
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}
/** Get results in the requested segment. */
export function currentResults(results: Run[], segment: number): Run[] {
	return results.filter((r) => r.segment === segment)
}
/** Baseline metric is first run in segment. */
export function findBaselineMetric(results: Run[], segment: number): number | null {
	const cur = currentResults(results, segment)
	return cur.length > 0 ? cur[0]!.metric : null
}
/** Compute pi's MAD confidence score for the current segment. */
export function computeConfidence(
	results: Run[],
	segment: number,
	direction: BestDirection,
): number | null {
	const cur = currentResults(results, segment).filter((r) => r.metric > 0)
	if (cur.length < 3) return null
	const values = cur.map((r) => r.metric)
	const median = sortedMedian(values)
	const mad = sortedMedian(values.map((v) => Math.abs(v - median)))
	if (mad === 0) return null
	const baseline = findBaselineMetric(results, segment)
	if (baseline === null) return null
	let bestKept: number | null = null
	for (const r of cur)
		if (
			r.status === 'keep' &&
			r.metric > 0 &&
			(bestKept === null || isBetter(r.metric, bestKept, direction))
		)
			bestKept = r.metric
	if (bestKept === null || bestKept === baseline) return null
	return Math.abs(bestKept - baseline) / mad
}

/** Format integer with comma thousands separators after rounding. */
export function commas(n: number): string {
	const s = String(Math.round(n))
	const parts: string[] = []
	for (let i = s.length; i > 0; i -= 3) parts.unshift(s.slice(Math.max(0, i - 3), i))
	return parts.join(',')
}
/** Format number with commas and optional fixed decimals. */
export function fmtNum(n: number, decimals = 0): string {
	if (decimals > 0) {
		const int = Math.floor(Math.abs(n))
		const frac = (Math.abs(n) - int).toFixed(decimals).slice(1)
		return (n < 0 ? '-' : '') + commas(int) + frac
	}
	return commas(n)
}
/** Format nullable metric value with unit. */
export function formatNum(value: number | null, unit: string): string {
	if (value === null) return '—'
	return (value === Math.round(value) ? fmtNum(value) : fmtNum(value, 2)) + (unit || '')
}
/** Format elapsed milliseconds as Xm XXs or XXs. */
export function formatElapsed(ms: number): string {
	const totalSec = Math.floor(ms / 1000)
	const m = Math.floor(totalSec / 60)
	const s = totalSec % 60
	return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}
function formatMetric(value: number): string {
	if (!Number.isFinite(value)) return '—'
	return Number.isInteger(value) ? String(value) : value.toFixed(2)
}
/** Format percentage delta relative to baseline. */
export function formatDelta(value: number, baseline: number | null): string {
	if (baseline === null || baseline === 0 || value === baseline) return ''
	const pct = ((value - baseline) / baseline) * 100
	return ` (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)`
}
/** Baseline for a run is first run in same segment. */
export function baselineFor(run: Run, all: Run[]): number | null {
	return all.find((r) => r.segment === run.segment)?.metric ?? null
}
function asiField(asi: Record<string, unknown> | undefined, key: string, label: string): string {
	const v = asi?.[key]
	return typeof v === 'string' && v.trim() ? `${label}: ${v.trim()}` : ''
}
/** Format one compact run line for digests/compaction. */
export function formatRunLine(run: Run, baseline: number | null): string {
	const head = `#${run.run} ${run.status.padEnd('checks_failed'.length)} ${formatMetric(run.metric)}${formatDelta(run.metric, baseline)}`
	return [
		head,
		run.description ? `desc: ${run.description}` : '',
		asiField(run.asi, 'hypothesis', 'hyp'),
		asiField(run.asi, 'next_action_hint', 'next'),
		asiField(run.asi, 'rollback_reason', 'rollback'),
	]
		.filter(Boolean)
		.join(' | ')
}

function bestMetric(runs: Run[], direction: BestDirection): number | null {
	const kept = runs.filter((r) => r.status === 'keep').map((r) => r.metric)
	if (!kept.length) return null
	return direction === 'lower' ? Math.min(...kept) : Math.max(...kept)
}
/** Build a compact autoresearch state digest for resume messages. */
export function buildDigest(state: SessionState, opts: { recentRuns?: number } = {}): string {
	const runs = currentResults(state.results, state.currentSegment)
	const header = `session: ${state.name ?? '—'} | metric: ${state.metricName} (${state.metricUnit || 'unitless'}, ${state.bestDirection} is better)`
	if (!runs.length)
		return [header, 'runs: 0 — no experiments yet; take a baseline first.'].join('\n')
	const counts: Record<RunStatus, number> = { keep: 0, discard: 0, crash: 0, checks_failed: 0 }
	for (const r of runs) counts[r.status]++
	const baseline = findBaselineMetric(state.results, state.currentSegment)
	const best = bestMetric(runs, state.bestDirection)
	const confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection)
	const countParts = [`${counts.keep} keep`, `${counts.discard} discard`, `${counts.crash} crash`]
	if (counts.checks_failed) countParts.push(`${counts.checks_failed} checks_failed`)
	const conf = confidence === null ? '' : ` | confidence: ${confidence.toFixed(1)}×`
	const recent = runs.slice(-(opts.recentRuns ?? 3))
	return [
		header,
		`runs: ${runs.length} (${countParts.join(', ')}) | baseline: ${formatNum(baseline, state.metricUnit)} | best: ${formatNum(best, state.metricUnit)}${best === null ? '' : formatDelta(best, baseline)}${conf}`,
		'rules: .auto/prompt.md (read if you have not this turn) | ideas: .auto/ideas.md',
		'recent:',
		...recent.map((r) => `  ${formatRunLine(r, baselineFor(r, state.results))}`),
	].join('\n')
}
/** Compose structural auto-resume user message. */
export function composeResumeMessage(digest: string): string {
	return `${RESUME_PREAMBLE}\n\nBe careful not to overfit to the benchmarks and do not cheat on the benchmarks.\n\n<${STATE_TAG}>\n${digest}\n</${STATE_TAG}>`
}
/** Detect resume-originated messages structurally. */
export function isResumeMessage(text: string): boolean {
	return text.startsWith(RESUME_PREAMBLE) && text.includes(`<${STATE_TAG}>`)
}

/** Return .auto directory path. */
export function autoDir(workdir: string): string {
	return path.join(workdir, AUTO_DIR)
}
export function logPath(workdir: string): string {
	return path.join(autoDir(workdir), 'log.jsonl')
}
export function promptPath(workdir: string): string {
	return path.join(autoDir(workdir), 'prompt.md')
}
export function ideasPath(workdir: string): string {
	return path.join(autoDir(workdir), 'ideas.md')
}
export function checksPath(workdir: string): string {
	return path.join(autoDir(workdir), 'checks.sh')
}
export function measurePath(workdir: string): string {
	return path.join(autoDir(workdir), 'measure.sh')
}
export function configPath(workdir: string): string {
	return path.join(autoDir(workdir), 'config.json')
}
export function sessionFilePath(workdir: string): string {
	return path.join(autoDir(workdir), 'amp-session.json')
}
export function hookPath(workdir: string, hook: 'before' | 'after'): string {
	return path.join(autoDir(workdir), 'hooks', `${hook}.sh`)
}

/** Read .auto/config.json, returning {} when missing/invalid. */
export function readConfig(workdir: string): AutoConfig {
	try {
		if (!fs.existsSync(configPath(workdir))) return {}
		const parsed: unknown = JSON.parse(fs.readFileSync(configPath(workdir), 'utf-8'))
		return isObjectRecord(parsed) ? (parsed as AutoConfig) : {}
	} catch {
		return {}
	}
}
/** Read positive integer maxIterations, else null. */
export function readMaxExperiments(workdir: string): number | null {
	const v = readConfig(workdir).maxIterations
	return typeof v === 'number' && v > 0 ? Math.floor(v) : null
}
/** Read positive integer maxAutoResumeTurns, defaulting to 20. */
export function readMaxAutoResumeTurns(workdir: string): number {
	const v = readConfig(workdir).maxAutoResumeTurns
	return typeof v === 'number' && v > 0 ? Math.floor(v) : DEFAULT_MAX_AUTO_RESUME_TURNS
}
/** Resolve configured workingDir absolute/relative to initDir, else initDir. */
export function resolveWorkDir(initDir: string): string {
	const wd = readConfig(initDir).workingDir
	if (typeof wd !== 'string' || wd === '') return initDir
	return path.isAbsolute(wd) ? wd : path.resolve(initDir, wd)
}
function validSession(value: unknown): value is AmpSession {
	return (
		isObjectRecord(value) &&
		value.version === 1 &&
		typeof value.threadID === 'string' &&
		typeof value.workdir === 'string' &&
		typeof value.active === 'boolean' &&
		typeof value.autoResumeTurns === 'number' &&
		typeof value.activatedAt === 'number'
	)
}
/** Read persisted Amp session file, null for missing/corrupt/wrong shape. */
export function readSessionFile(workdir: string): AmpSession | null {
	try {
		const p = sessionFilePath(workdir)
		if (!fs.existsSync(p)) return null
		const parsed: unknown = JSON.parse(fs.readFileSync(p, 'utf-8'))
		return validSession(parsed) ? parsed : null
	} catch {
		return null
	}
}
/** Write persisted Amp session with mkdir and temp-file rename. */
export function writeSessionFile(workdir: string, session: AmpSession): void {
	const dir = autoDir(workdir)
	fs.mkdirSync(dir, { recursive: true })
	const dest = sessionFilePath(workdir)
	const tmp = path.join(dir, `.amp-session.${process.pid}.${Date.now()}.tmp`)
	fs.writeFileSync(tmp, `${JSON.stringify(session, null, 2)}\n`)
	fs.renameSync(tmp, dest)
}

// ── Runtime/session bindings ──

interface ThreadRuntime {
	workdir: string
	lastRunChecks: { pass: boolean; output: string; duration: number } | null
	lastRunMetrics: Record<string, number> | null
}

const runtimes = new Map<string, ThreadRuntime>()
const inflight = new Map<string, { startedAt: number }>()

export function resetRuntimesForTest(): void {
	runtimes.clear()
	inflight.clear()
}
export function bindThreadSession(threadID: string, workdir: string): void {
	runtimes.set(threadID, { workdir, lastRunChecks: null, lastRunMetrics: null })
	writeBinding(threadID, workdir)
}
export function boundWorkdirForThread(threadID: string): string | null {
	return runtimes.get(threadID)?.workdir ?? null
}
function runtimeForThread(threadID: string): ThreadRuntime | null {
	return runtimes.get(threadID) ?? null
}

// ── Thread→workdir bindings index ──
// A derived, disposable cache so event handlers can find a thread's workdir
// after a plugin reload. `.auto/amp-session.json` in the workdir remains the
// authoritative record: a bindings entry is only honored when that session
// file names the same thread.

let bindingsFile = path.join(os.homedir(), '.config', 'amp', 'autoresearch', 'bindings.json')
/** Override the bindings index location (tests only). */
export function setBindingsFileForTest(p: string): void {
	bindingsFile = p
}
function readBindings(): Record<string, string> {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(bindingsFile, 'utf-8'))
		if (!isObjectRecord(parsed)) return {}
		const out: Record<string, string> = {}
		for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v
		return out
	} catch {
		return {}
	}
}
function writeBinding(threadID: string, workdir: string): void {
	try {
		const bindings = readBindings()
		bindings[threadID] = workdir
		fs.mkdirSync(path.dirname(bindingsFile), { recursive: true })
		const tmp = `${bindingsFile}.${process.pid}.tmp`
		fs.writeFileSync(tmp, `${JSON.stringify(bindings, null, 2)}\n`)
		fs.renameSync(tmp, bindingsFile)
	} catch {}
}

/**
 * Find the active session for a thread: in-memory binding first, then the
 * bindings index validated against the workdir's amp-session.json.
 * Returns null when the thread holds no active session.
 */
export function sessionForThread(
	threadID: string,
): { workdir: string; session: AmpSession } | null {
	const candidates: string[] = []
	const bound = boundWorkdirForThread(threadID)
	if (bound) candidates.push(bound)
	const indexed = readBindings()[threadID]
	if (indexed && indexed !== bound) candidates.push(indexed)
	for (const workdir of candidates) {
		const session = readSessionFile(workdir)
		if (session && session.active && session.threadID === threadID) {
			if (!boundWorkdirForThread(threadID)) bindThreadSession(threadID, workdir)
			return { workdir, session }
		}
	}
	return null
}

// ── Git helpers ──

async function git(
	args: string[],
	cwd: string,
	timeout = 10_000,
): Promise<{ stdout: string; stderr: string }> {
	const r = await execFileAsync('git', args, { cwd, timeout, maxBuffer: 1024 * 1024 })
	return { stdout: String(r.stdout), stderr: String(r.stderr) }
}
export async function gitToplevel(dir: string): Promise<string | null> {
	try {
		return (await git(['rev-parse', '--show-toplevel'], dir)).stdout.trim() || null
	} catch {
		return null
	}
}
export async function gitIsDirty(dir: string): Promise<boolean> {
	try {
		// Exclude .auto/ — autoresearch's own state files (log.jsonl,
		// amp-session.json) must not block re-init, mirroring the revert globs.
		const args = [
			'status',
			'--porcelain',
			'--',
			'.',
			':(exclude,glob)**/.auto',
			':(exclude,glob)**/.auto/**',
		]
		return (await git(args, dir)).stdout.trim().length > 0
	} catch {
		// Fail closed: a git error (timeout, huge status output) must refuse init
		// rather than report clean — discards destroy uncommitted work.
		return true
	}
}
export async function gitCurrentBranch(dir: string): Promise<string | null> {
	try {
		return (await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).stdout.trim() || null
	} catch {
		return null
	}
}
export async function gitDefaultBranch(dir: string): Promise<string | null> {
	try {
		const ref = (await git(['symbolic-ref', 'refs/remotes/origin/HEAD'], dir)).stdout.trim()
		if (ref) return ref.replace(/^refs\/remotes\/origin\//, '')
	} catch {}
	try {
		const branches = (await git(['branch', '--list', 'main', 'master'], dir)).stdout
		if (/\bmain\b/.test(branches)) return 'main'
		if (/\bmaster\b/.test(branches)) return 'master'
	} catch {}
	return null
}
export async function gitShortHead(dir: string): Promise<string | null> {
	try {
		return (await git(['rev-parse', '--short=7', 'HEAD'], dir)).stdout.trim() || null
	} catch {
		return null
	}
}
export async function gitCommitAll(
	dir: string,
	message: string,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
	try {
		await git(['add', '-A'], dir)
		try {
			await git(['diff', '--cached', '--quiet'], dir)
			return { ok: false, error: 'nothing to commit' }
		} catch {}
		await git(['commit', '-m', message], dir)
		const sha = await gitShortHead(dir)
		return sha ? { ok: true, sha } : { ok: false, error: 'commit succeeded but HEAD not found' }
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) }
	}
}
export async function gitRevertAll(dir: string): Promise<void> {
	await execFileAsync(
		'bash',
		[
			'-c',
			"git checkout -- . ':(exclude,glob)**/.auto' ':(exclude,glob)**/.auto/**'\ngit clean -fd -e '.auto' -e '**/.auto/**' 2>/dev/null",
		],
		{ cwd: dir, timeout: 10_000 },
	)
}

// ── Hooks/truncation helpers ──

export interface HookResult {
	fired: boolean
	exitCode: number | null
	stdout: string
	stderr: string
	timedOut: boolean
	durationMs: number
}
function isExecutableFile(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK)
		return fs.statSync(file).isFile()
	} catch {
		return false
	}
}
export async function runHook(
	payload: Record<string, unknown> & { event: 'before' | 'after'; cwd: string },
): Promise<HookResult> {
	const script = hookPath(payload.cwd, payload.event)
	if (!isExecutableFile(script))
		return { fired: false, exitCode: null, stdout: '', stderr: '', timedOut: false, durationMs: 0 }
	const t0 = Date.now()
	return await new Promise((resolve) => {
		const child = spawn('bash', [script], {
			cwd: payload.cwd,
			detached: true, // group leader, so killTree reaps grandchildren on timeout
			stdio: ['pipe', 'pipe', 'pipe'],
		})
		let stdout = Buffer.alloc(0),
			stderr = '',
			timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			killTree(child.pid)
		}, 30_000)
		child.stdout.on('data', (b: Buffer) => {
			if (stdout.length < 8192) stdout = Buffer.concat([stdout, b]).subarray(0, 8192)
		})
		child.stderr.on('data', (b: Buffer) => {
			if (stderr.length < 8192) stderr = (stderr + b.toString('utf8')).slice(0, 8192)
		})
		child.on('close', (code) => {
			clearTimeout(timer)
			resolve({
				fired: true,
				exitCode: code,
				stdout: stdout.toString('utf8'),
				stderr,
				timedOut,
				durationMs: Date.now() - t0,
			})
		})
		child.on('error', (e) => {
			clearTimeout(timer)
			resolve({
				fired: true,
				exitCode: null,
				stdout: stdout.toString('utf8'),
				stderr: stderr + e.message,
				timedOut,
				durationMs: Date.now() - t0,
			})
		})
		child.stdin.end(JSON.stringify(payload))
	})
}
export function hookResultText(stage: 'before' | 'after', result: HookResult): string | null {
	if (!result.fired) return null
	if (result.timedOut) return `[${stage} hook timed out after 30s]`
	if (result.exitCode !== 0)
		return [`[${stage} hook exited ${result.exitCode}]`, result.stderr.trim(), result.stdout.trim()]
			.filter(Boolean)
			.join('\n')
	return result.stdout.trim() || null
}
function appendHookLogEntryIfConfigured(
	workdir: string,
	stage: 'before' | 'after',
	result: HookResult,
): void {
	if (!result.fired) return
	try {
		const lp = logPath(workdir)
		if (!fs.existsSync(lp) || !hasConfigHeader(fs.readFileSync(lp, 'utf-8'))) return
		fs.appendFileSync(
			lp,
			JSON.stringify({
				type: 'hook',
				stage,
				exit_code: result.exitCode,
				duration_ms: result.durationMs,
				stdout_bytes: Buffer.byteLength(result.stdout),
				timed_out: result.timedOut,
			}) + '\n',
		)
	} catch {}
}
export function truncateExperimentOutput(
	output: string,
	maxLines = 10,
	maxBytes = 4096,
): { content: string; truncated: boolean } {
	let lines = output.split('\n')
	let truncated = false
	if (lines.length > maxLines) {
		lines = lines.slice(-maxLines)
		truncated = true
	}
	let content = lines.join('\n')
	const b = Buffer.from(content)
	if (b.length > maxBytes) {
		content = b.subarray(b.length - maxBytes).toString('utf8')
		truncated = true
	}
	return { content, truncated }
}
function killTree(pid: number | undefined): void {
	if (!pid) return
	try {
		process.kill(-pid, 'SIGTERM')
	} catch {
		try {
			process.kill(pid, 'SIGTERM')
		} catch {}
	}
	setTimeout(() => {
		try {
			process.kill(-pid, 'SIGKILL')
		} catch {
			try {
				process.kill(pid, 'SIGKILL')
			} catch {}
		}
	}, 1000).unref?.()
}
export function checkSecondaryMetrics(
	established: string[],
	provided: Record<string, number> | undefined,
	force = false,
): { ok: true } | { error: string } {
	const p = new Set(Object.keys(provided ?? {}))
	const missing = established.filter((n) => !p.has(n))
	if (missing.length) return { error: `Missing secondary metrics: ${missing.join(', ')}` }
	const news = [...p].filter((n) => !established.includes(n))
	if (news.length && !force)
		return {
			error: `New secondary metric${news.length > 1 ? 's' : ''} not previously tracked: ${news.join(', ')}. Use force:true only if valuable.`,
		}
	return { ok: true }
}
export function buildSessionSnapshot(state: SessionState): Record<string, unknown> {
	const runs = currentResults(state.results, state.currentSegment)
	return {
		metric_name: state.metricName,
		metric_unit: state.metricUnit,
		direction: state.bestDirection,
		baseline_metric: findBaselineMetric(state.results, state.currentSegment),
		best_metric: bestMetric(runs, state.bestDirection),
		run_count: runs.length,
		goal: state.name ?? '',
	}
}

// ── Kickoff prompts (port of pi's autoresearch-create skill) ──

const LOOP_RULES = `## Loop Rules

**LOOP FOREVER.** Never ask "should I continue?" — the user expects autonomous work.

- **Primary metric is king.** Improved → \`keep\`. Worse/equal → \`discard\`. Secondary metrics rarely affect this.
- **Annotate every run with \`asi\`.** Record what you learned — not what you did. Annotate failures and crashes heavily: reverted changes leave no other trace, and unrecorded dead ends get re-discovered.
- **Watch the confidence score.** After 3+ runs, log_experiment reports the best improvement as a multiple of the session noise floor. ≥2.0× is likely real; <1.0× is within noise — consider re-running before keeping. Advisory only.
- **Simpler is better.** Removing code for equal perf = keep. Ugly complexity for tiny gain = probably discard.
- **Don't thrash.** Repeatedly reverting the same idea? Try something structurally different.
- **Crashes:** fix if trivial, otherwise log and move on.
- **Think longer when stuck.** Re-read source, study the measurement output, reason about what the machine is actually doing.
- **Stuck for 3+ discards in a row: consult the oracle** (if available) before trying more variations — give it the measurement data, your dead-end notes from \`.auto/log.jsonl\`, and the relevant source files, and ask where the metric is actually being spent.
- **Ideas backlog:** append promising-but-deferred optimizations as bullets to \`.auto/ideas.md\`; prune stale entries on resume.
- Be careful not to overfit to the benchmark and do not cheat on the benchmark.

**NEVER STOP.** The user may be away for hours. Keep going until interrupted.`

/** Kickoff message for a brand-new session (no .auto/prompt.md yet). */
export function buildCreateKickoff(goal: string, workdir: string): string {
	return `Set up and run an autonomous experiment loop (autoresearch).

**Goal:** ${goal}
**Working directory:** ${workdir}

## Setup

1. Infer (or ask once, briefly): the benchmark command, the primary metric (+ direction), files in scope, and constraints.
2. \`git checkout -b autoresearch/<goal-slug>-<date>\`
3. Read the source files. Understand the workload deeply before writing anything.
4. \`mkdir -p .auto\`, then write:
   - \`.auto/prompt.md\` — the session playbook (objective, metrics, how to run, files in scope, off limits, constraints, "what's been tried"). A fresh agent with no context must be able to run the loop from this file alone. Invest in it.
   - \`.auto/measure.sh\` — bash, \`set -euo pipefail\`, runs the benchmark and prints \`METRIC name=value\` lines (primary metric name must match init_experiment's metric_name). For fast noisy benchmarks (<5s), run several times inside the script and report the median.
   - Add \`.auto/log.jsonl\` and \`.auto/amp-session.json\` to .gitignore.
   - Only if constraints require correctness validation, write \`.auto/checks.sh\` (runs after every passing benchmark; keep output minimal — errors only).
   Commit these files.
5. Call \`init_experiment\` with working_dir set to the workspace root (${workdir}), plus name, metric_name, metric_unit, direction. Pick a unit that puts typical values in the 1–1000 range so dashboards and deltas stay readable: measure a ~0.014s benchmark as \`wall_ms\` ≈ 14, not \`wall_seconds\` ≈ 0.014.
6. Run the baseline: \`run_experiment\` (it always executes \`.auto/measure.sh\`), then \`log_experiment\` with status keep.
7. Loop: edit code → run_experiment → log_experiment (keep improves, discard regresses — reverts are automatic; never commit or revert manually).

${LOOP_RULES}`
}

/** Kickoff message for resuming an existing session (.auto/prompt.md present). */
export function buildResumeKickoff(workdir: string): string {
	return `Resume the autoresearch experiment loop in ${workdir}.

1. Read \`.auto/prompt.md\` and the recent entries of \`.auto/log.jsonl\`, plus \`git log --oneline -20\`.
2. Call \`init_experiment\` with working_dir=${workdir} and the same name/metric as the existing session (this rebinds without starting a new segment).
3. Check \`.auto/ideas.md\` for promising paths; prune stale entries.
4. Continue: edit code → run_experiment → log_experiment. Reverts and commits are automatic.

${LOOP_RULES}`
}

// ── Dashboard server ──

interface DashboardServer {
	port: number
	stop: () => void
	broadcast: () => void
}
const dashboards = new Map<string, DashboardServer>()
/** Notify interested parties (dashboard SSE, status item) after a logged run. */
let onExperimentLogged: ((workdir: string) => void) | null = null

function dashboardHtml(sessionName: string): string {
	// The plugin file may be symlinked into ~/.config/amp/plugins; resolve the
	// real path so the asset ships with the repo checkout.
	try {
		const here = path.dirname(fs.realpathSync(import.meta.path))
		const html = fs.readFileSync(path.join(here, 'assets', 'dashboard.html'), 'utf-8')
		return html.replaceAll('__AUTORESEARCH_TITLE__', sessionName)
	} catch {
		return `<!DOCTYPE html><meta charset="utf-8"><title>${sessionName}</title><body style="font-family:monospace;background:#0d1117;color:#c9d1d9;padding:2rem"><h1>${sessionName}</h1><p>Dashboard asset missing — showing raw log.</p><pre id="log"></pre><script>fetch('autoresearch.jsonl',{cache:'no-store'}).then(r=>r.text()).then(t=>{document.getElementById('log').textContent=t});new EventSource('/events').addEventListener('jsonl-updated',()=>location.reload())</script></body>`
	}
}

/** Start (or reuse) the local dashboard server for a workdir. Returns its URL. */
export function startDashboard(workdir: string): string {
	const existing = dashboards.get(workdir)
	if (existing) return `http://127.0.0.1:${existing.port}/`
	const clients = new Set<ReadableStreamDefaultController>()
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(req) {
			const { pathname } = new URL(req.url)
			if (pathname === '/') {
				const lp = logPath(workdir)
				const name = fs.existsSync(lp)
					? extractSessionName(fs.readFileSync(lp, 'utf-8'))
					: 'Autoresearch'
				return new Response(dashboardHtml(name), {
					headers: { 'content-type': 'text/html; charset=utf-8' },
				})
			}
			if (pathname === '/autoresearch.jsonl') {
				const lp = logPath(workdir)
				return new Response(fs.existsSync(lp) ? fs.readFileSync(lp, 'utf-8') : '', {
					headers: { 'content-type': 'application/jsonl', 'cache-control': 'no-store' },
				})
			}
			if (pathname === '/events') {
				let ctrl: ReadableStreamDefaultController
				const stream = new ReadableStream({
					start(c) {
						ctrl = c
						clients.add(c)
						c.enqueue('retry: 1000\n\n')
					},
					cancel() {
						clients.delete(ctrl)
					},
				})
				return new Response(stream, {
					headers: {
						'content-type': 'text/event-stream',
						'cache-control': 'no-cache',
						connection: 'keep-alive',
					},
				})
			}
			return new Response('not found', { status: 404 })
		},
	})
	const broadcast = () => {
		for (const c of clients)
			try {
				c.enqueue(`event: jsonl-updated\ndata: ${Date.now()}\n\n`)
			} catch {}
	}
	// Amp runs plugins in more than one host process; log_experiment may execute
	// in a different process than this server, so in-process signaling cannot be
	// the only trigger. Poll the log file — disk is the shared channel.
	const lp = logPath(workdir)
	fs.watchFile(lp, { interval: 1000 }, (cur, prev) => {
		if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) broadcast()
	})
	const entry: DashboardServer = {
		port: server.port ?? 0,
		stop: () => {
			fs.unwatchFile(lp)
			for (const c of clients)
				try {
					c.close()
				} catch {}
			clients.clear()
			server.stop(true)
			dashboards.delete(workdir)
		},
		broadcast,
	}
	dashboards.set(workdir, entry)
	return `http://127.0.0.1:${entry.port}/`
}

/** Stop the dashboard server for a workdir, if running. */
export function stopDashboard(workdir: string): void {
	dashboards.get(workdir)?.stop()
}

// ── Loop decisions ──

export interface ContinueDecision {
	action: 'continue' | 'stop-cap' | 'stop-stranded' | 'none'
	userMessage?: string
	notice?: string
}

/**
 * Decide whether to auto-resume after an agent turn.
 * Gates (all must hold): session active, turn status 'done', a log_experiment
 * tool call completed this turn, resume cap not reached, and the on-disk log
 * still exists (fail closed on stranded sessions, e.g. after a branch switch).
 */
export function decideContinue(args: {
	session: AmpSession
	workdir: string
	turnStatus: 'done' | 'error' | 'cancelled'
	turnLoggedExperiment: boolean
	maxTurns: number
}): ContinueDecision {
	const { session, workdir, turnStatus, turnLoggedExperiment, maxTurns } = args
	if (!session.active || turnStatus !== 'done' || !turnLoggedExperiment) return { action: 'none' }
	if (!fs.existsSync(logPath(workdir)))
		return {
			action: 'stop-stranded',
			notice: `Autoresearch stopped: ${logPath(workdir)} is missing (branch switch?). Session deactivated.`,
		}
	if (session.autoResumeTurns >= maxTurns)
		return {
			action: 'stop-cap',
			notice: `Autoresearch paused: auto-resume cap reached (${maxTurns} turns). Send a message to continue, or raise maxAutoResumeTurns in .auto/config.json.`,
		}
	const state = reconstructJsonlState(fs.readFileSync(logPath(workdir), 'utf-8'))
	return { action: 'continue', userMessage: composeResumeMessage(buildDigest(state)) }
}

/** True when a completed log_experiment tool call appears in the turn's messages. */
export function turnLoggedExperiment(
	toolCalls: Array<{ call: { tool: string }; result: { status: string } }>,
): boolean {
	return toolCalls.some((tc) => tc.call.tool === 'log_experiment' && tc.result.status === 'done')
}

/** Mark a session inactive on disk and tear down its dashboard. */
export function deactivateSession(workdir: string): void {
	const s = readSessionFile(workdir)
	if (s?.active) writeSessionFile(workdir, { ...s, active: false })
	stopDashboard(workdir)
}

// ── Tool execute functions ──

type ToolCtx = {
	ui?: { confirm?: (o: { title: string; message?: string }) => Promise<boolean> }
	thread: { id: string; state?: { get?: () => Promise<string> } }
}
const unbound =
	'No experiment session for this thread. Call init_experiment with the workspace root first.'
/**
 * Re-validate that this thread still owns the workdir's session (F2 in the
 * final review): amp-session.json arbitrates across takeovers and across
 * plugin processes (CLI + IDE); the in-memory binding alone must not authorize
 * git-mutating tools.
 */
function ownershipError(threadID: string, workdir: string): string | null {
	const s = readSessionFile(workdir)
	if (s?.active && s.threadID === threadID) return null
	return `❌ This thread no longer holds the autoresearch session in ${workdir}. Call init_experiment to rebind.`
}
/** Coerce agent-supplied seconds to a positive finite number, else the default. */
function positiveSeconds(value: unknown, fallback: number): number {
	const n = Number(value)
	return Number.isFinite(n) && n > 0 ? n : fallback
}
async function confirm(ui: ToolCtx['ui'], title: string, message: string): Promise<boolean> {
	// Headless escape hatch (execute mode has no UI and confirms fail closed):
	// only for users who deliberately opt in, e.g. overnight `amp -x` loops.
	if (process.env.AMP_AUTORESEARCH_ASSUME_YES === '1') return true
	try {
		return !!(await ui?.confirm?.({ title, message }))
	} catch {
		return false
	}
}
function readState(workdir: string): SessionState {
	return reconstructJsonlState(
		fs.existsSync(logPath(workdir)) ? fs.readFileSync(logPath(workdir), 'utf-8') : '',
	)
}

export async function executeInit(input: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
	try {
		const wd = String(input.working_dir ?? ''),
			name = String(input.name ?? ''),
			metricName = String(input.metric_name ?? '')
		const metricUnit = typeof input.metric_unit === 'string' ? input.metric_unit : ''
		const bestDirection: BestDirection = input.direction === 'higher' ? 'higher' : 'lower'
		if (!path.isAbsolute(wd) || !fs.existsSync(wd) || !fs.statSync(wd).isDirectory())
			return '❌ working_dir must be an existing absolute directory'
		const top = await gitToplevel(fs.realpathSync(wd))
		if (!top) return '❌ working_dir must be inside a git repository'
		const workdir = fs.realpathSync(resolveWorkDir(top))
		const existing = readSessionFile(workdir),
			same = existing?.active && existing.threadID === ctx.thread.id,
			takeover = existing?.active && existing.threadID !== ctx.thread.id
		if (takeover) {
			// One dialog covers both takeover and workdir identity.
			if (
				!(await confirm(
					ctx.ui,
					'Take over autoresearch session?',
					`.auto/amp-session.json in ${workdir} is held by thread ${existing!.threadID}. Take over?`,
				))
			)
				return `❌ Autoresearch session is held by thread ${existing!.threadID}.`
		} else if (
			!same &&
			!(await confirm(
				ctx.ui,
				'Start autoresearch session?',
				`Start autoresearch session in ${workdir}?`,
			))
		)
			return '❌ Refusing to start autoresearch session without user confirmation.'
		const oldText = fs.existsSync(logPath(workdir))
			? fs.readFileSync(logPath(workdir), 'utf-8')
			: ''
		const state = reconstructJsonlState(oldText)
		const sameConfig =
			state.name === name &&
			state.metricName === metricName &&
			state.metricUnit === metricUnit &&
			state.bestDirection === bestDirection
		if (!(same && sameConfig)) {
			if (await gitIsDirty(workdir))
				return '❌ Working tree is dirty — commit or stash first. Autoresearch auto-reverts will destroy uncommitted changes.'
			const cur = await gitCurrentBranch(workdir),
				def = await gitDefaultBranch(workdir)
			if (
				cur &&
				def &&
				cur === def &&
				!(await confirm(
					ctx.ui,
					'Run autoresearch on default branch?',
					`Current branch is ${cur}. Consider: git checkout -b autoresearch/${name.replace(/\W+/g, '-')}-${new Date().toISOString().slice(0, 10)}`,
				))
			)
				return `❌ Refusing to run on default branch. Try git checkout -b autoresearch/${name.replace(/\W+/g, '-')}-${new Date().toISOString().slice(0, 10)}`
		}
		fs.mkdirSync(autoDir(workdir), { recursive: true })
		let resumed = sameConfig && state.results.length > 0
		if (!sameConfig)
			fs.appendFileSync(
				logPath(workdir),
				JSON.stringify({ type: 'config', name, metricName, metricUnit, bestDirection }) + '\n',
			)
		writeSessionFile(workdir, {
			version: 1,
			threadID: ctx.thread.id,
			workdir,
			active: true,
			autoResumeTurns: existing?.autoResumeTurns ?? 0,
			activatedAt: Date.now(),
		})
		bindThreadSession(ctx.thread.id, workdir)
		const rt = runtimeForThread(ctx.thread.id)!
		rt.lastRunChecks = null
		rt.lastRunMetrics = null
		let hookText = ''
		if (!same) {
			const h = await runHook({
				event: 'before',
				cwd: workdir,
				next_run: state.results.length + 1,
				last_run: null,
				session: buildSessionSnapshot(state),
			})
			appendHookLogEntryIfConfigured(workdir, 'before', h)
			hookText = hookResultText('before', h) ?? ''
		}
		const cap = readMaxExperiments(workdir)
		return [
			`✅ Experiment ${resumed ? 'resumed' : 'initialized'}: "${name}"`,
			`Metric: ${metricName} (${metricUnit || 'unitless'}, ${bestDirection} is better)`,
			`Workdir: ${workdir}`,
			`Runs so far: ${state.results.length}`,
			cap ? `Max iterations: ${cap}` : '',
			'Next: Run the baseline: run_experiment()',
			hookText,
		]
			.filter(Boolean)
			.join('\n')
	} catch (e) {
		return `❌ init_experiment failed: ${e instanceof Error ? e.message : String(e)}`
	}
}

export async function executeRun(input: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
	const rt = runtimeForThread(ctx.thread.id)
	if (!rt) return unbound
	const workdir = rt.workdir
	const owner = ownershipError(ctx.thread.id, workdir)
	if (owner) return owner
	if (!fs.existsSync(measurePath(workdir)))
		return '❌ Missing .auto/measure.sh. Write a benchmark script that emits METRIC name=value lines and commit it first.'
	const state = readState(workdir),
		cap = readMaxExperiments(workdir),
		segCount = currentResults(state.results, state.currentSegment).length
	if (cap !== null && segCount >= cap) return `🛑 Maximum experiments reached (${cap}). Stop.`
	const running = inflight.get(workdir)
	if (running)
		return `❌ Experiment already running, started ${Math.floor((Date.now() - running.startedAt) / 1000)}s ago.`
	inflight.set(workdir, { startedAt: Date.now() })
	try {
		const h = await runHook({
			event: 'before',
			cwd: workdir,
			next_run: state.results.length + 1,
			last_run: state.results.at(-1) ?? null,
			session: buildSessionSnapshot(state),
		})
		appendHookLogEntryIfConfigured(workdir, 'before', h)
		const timeout = positiveSeconds(input.timeout_seconds, 600) * 1000,
			t0 = Date.now()
		let out = '',
			exitCode: number | null = null,
			timedOut = false,
			cancelled = false
		await new Promise<void>((resolve) => {
			const child = spawn('bash', [measurePath(workdir)], {
				cwd: workdir,
				detached: true,
				stdio: ['ignore', 'pipe', 'pipe'],
			})
			const add = (b: Buffer) => {
				out += b.toString('utf8')
				if (out.length > 1024 * 1024) out = out.slice(-1024 * 1024)
			}
			child.stdout.on('data', add)
			child.stderr.on('data', add)
			const timer = setTimeout(() => {
				timedOut = true
				killTree(child.pid)
			}, timeout)
			const poll = setInterval(async () => {
				try {
					if ((await ctx.thread.state?.get?.()) === 'idle') {
						cancelled = true
						killTree(child.pid)
					}
				} catch {
					clearInterval(poll)
				}
			}, 5000)
			child.on('close', (c) => {
				exitCode = c
				clearTimeout(timer)
				clearInterval(poll)
				resolve()
			})
			child.on('error', (e) => {
				out += e.message
				clearTimeout(timer)
				clearInterval(poll)
				resolve()
			})
		})
		const duration = Date.now() - t0,
			benchmarkPassed = exitCode === 0 && !timedOut && !cancelled
		if (benchmarkPassed && fs.existsSync(checksPath(workdir))) {
			const ct0 = Date.now()
			try {
				const r = await execFileAsync('bash', [checksPath(workdir)], {
					cwd: workdir,
					timeout: positiveSeconds(input.checks_timeout_seconds, 300) * 1000,
					maxBuffer: 1024 * 1024,
				})
				rt.lastRunChecks = {
					pass: true,
					output: `${r.stdout}${r.stderr}`.trim().slice(-4096),
					duration: Date.now() - ct0,
				}
			} catch (e) {
				rt.lastRunChecks = {
					pass: false,
					output: e instanceof Error ? e.message.slice(-4096) : String(e).slice(-4096),
					duration: Date.now() - ct0,
				}
			}
		} else rt.lastRunChecks = null
		rt.lastRunMetrics = Object.fromEntries(parseMetricLines(out))
		const trunc = truncateExperimentOutput(out)
		let temp = ''
		if (trunc.truncated) {
			const p = path.join(os.tmpdir(), `amp-experiment-${Math.random().toString(16).slice(2)}.log`)
			fs.writeFileSync(p, out)
			temp = `\nFull output: ${p}`
		}
		return [
			`${benchmarkPassed ? '✅ PASSED' : timedOut ? '⏰ TIMEOUT' : cancelled ? '⚠️ CANCELLED' : '❌ FAILED'} exit=${exitCode} in ${formatElapsed(duration)}`,
			Object.keys(rt.lastRunMetrics).length
				? `Parsed metrics: ${Object.entries(rt.lastRunMetrics)
						.map(([k, v]) => `${k}=${v}`)
						.join(', ')}`
				: '',
			rt.lastRunChecks
				? rt.lastRunChecks.pass
					? `✅ Checks passed in ${formatElapsed(rt.lastRunChecks.duration)}`
					: `💥 CHECKS FAILED — log as checks_failed\n${rt.lastRunChecks.output}`
				: '',
			hookResultText('before', h) ?? '',
			trunc.content ? `\n── output tail ──\n${trunc.content}${temp}` : '',
		]
			.filter(Boolean)
			.join('\n')
	} finally {
		inflight.delete(workdir)
	}
}

export async function executeLog(input: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
	try {
		const rt = runtimeForThread(ctx.thread.id)
		if (!rt) return unbound
		const owner = ownershipError(ctx.thread.id, rt.workdir)
		if (owner) return owner
		const workdir = rt.workdir,
			state = readState(workdir),
			metrics = isObjectRecord(input.metrics) ? metricMapFrom(input.metrics) : {}
		if (
			input.status !== 'keep' &&
			input.status !== 'discard' &&
			input.status !== 'crash' &&
			input.status !== 'checks_failed'
		)
			return `❌ Invalid status ${JSON.stringify(input.status)}. Use keep, discard, crash, or checks_failed.`
		const status: RunStatus = input.status
		if (!Number.isFinite(Number(input.metric)))
			return '❌ metric must be a finite number (use 0 for crashes).'
		if (status === 'keep' && rt.lastRunChecks && !rt.lastRunChecks.pass)
			return `❌ Cannot keep — .auto/checks.sh failed.\n\n${rt.lastRunChecks.output.slice(-500)}\n\nLog as 'checks_failed' instead.`
		const chk = checkSecondaryMetrics(
			state.secondaryMetrics.map((m) => m.name),
			metrics,
			input.force === true,
		)
		if ('error' in chk) return `❌ ${chk.error}`
		const beforeBest = bestMetric(
			currentResults(state.results, state.currentSegment),
			state.bestDirection,
		)
		let entry: Record<string, unknown> = {
			run: state.results.length + 1,
			commit: String(input.commit ?? '').slice(0, 7),
			metric: Number(input.metric),
			metrics,
			status,
			description: String(input.description ?? ''),
			timestamp: Date.now(),
			confidence: null,
		}
		if (isObjectRecord(input.asi) && Object.keys(input.asi).length) entry.asi = input.asi
		const tempRun = runFrom(entry as RunEntry, state.currentSegment)
		state.results.push(tempRun)
		entry.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection)
		let gitLine = ''
		if (status === 'keep') {
			const gr = await gitCommitAll(
				workdir,
				`${entry.description}\n\nResult: ${JSON.stringify({ status, [state.metricName]: entry.metric, ...metrics })}`,
			)
			if (gr.ok) {
				entry.commit = gr.sha
				gitLine = `📝 Git: committed ${gr.sha}`
			} else gitLine = `⚠️ Git commit failed: ${gr.error}`
		}
		fs.mkdirSync(autoDir(workdir), { recursive: true })
		fs.appendFileSync(logPath(workdir), JSON.stringify(entry) + '\n')
		dashboards.get(workdir)?.broadcast()
		try {
			onExperimentLogged?.(workdir)
		} catch {}
		if (status !== 'keep') {
			// The jsonl entry is already persisted; a revert failure must not throw
			// into the outer catch, or an agent retry would duplicate the run entry.
			try {
				await gitRevertAll(workdir)
				gitLine = `📝 Git: reverted changes (${status}) — .auto/ preserved`
			} catch (e) {
				gitLine = `⚠️ Git revert failed: ${e instanceof Error ? e.message : String(e)} — revert manually before the next experiment`
			}
		}
		const h = await runHook({
			event: 'after',
			cwd: workdir,
			run_entry: entry,
			session: buildSessionSnapshot(state),
		})
		appendHookLogEntryIfConfigured(workdir, 'after', h)
		const seg = currentResults(state.results, state.currentSegment),
			baseline = findBaselineMetric(state.results, state.currentSegment),
			best = bestMetric(seg, state.bestDirection),
			counts: Record<RunStatus, number> = { keep: 0, discard: 0, crash: 0, checks_failed: 0 }
		for (const r of seg) counts[r.status]++
		const cap = readMaxExperiments(workdir)
		let limit = ''
		if (cap !== null && seg.length >= cap) {
			const s = readSessionFile(workdir)
			if (s) writeSessionFile(workdir, { ...s, active: false })
			limit = `\n🛑 Maximum experiments reached (${cap}). STOP the experiment loop now.`
		}
		rt.lastRunChecks = null
		rt.lastRunMetrics = null
		const conf =
			typeof entry.confidence === 'number'
				? `Confidence: ${entry.confidence.toFixed(1)}× noise floor — ${entry.confidence >= 2 ? 'improvement is likely real' : entry.confidence >= 1 ? 'borderline' : 'within noise'}`
				: 'Confidence: —'
		return [
			`${status === 'keep' ? '✅ kept' : status === 'discard' ? '↩️ discarded' : status === 'crash' ? '💥 crashed' : '⚠️ checks_failed'} #${entry.run}: ${entry.description}`,
			`${state.metricName}: ${formatNum(Number(entry.metric), state.metricUnit)} vs baseline${formatDelta(Number(entry.metric), baseline)} vs best-before${formatDelta(Number(entry.metric), beforeBest)}`,
			`Tallies: ${counts.keep} keep, ${counts.discard} discard, ${counts.crash} crash, ${counts.checks_failed} checks_failed`,
			conf,
			`Best so far: ${formatNum(best, state.metricUnit)}`,
			'Recent:',
			...seg.slice(-3).map((r) => `  ${formatRunLine(r, baselineFor(r, state.results))}`),
			gitLine,
			hookResultText('after', h) ?? '',
			limit,
		]
			.filter(Boolean)
			.join('\n')
	} catch (e) {
		return `❌ log_experiment failed: ${e instanceof Error ? e.message : String(e)}`
	}
}

export default function (amp: PluginAPI) {
	amp.registerTool({
		name: 'init_experiment',
		description: 'Initialize an autoresearch experiment session for this thread.',
		inputSchema: {
			type: 'object',
			properties: {
				working_dir: {
					type: 'string',
					description: 'Absolute path to the workspace root (must be a git repository)',
				},
				name: { type: 'string', description: 'Human-readable session name' },
				metric_name: {
					type: 'string',
					description:
						'Primary metric name, e.g. "wall_ms". Choose a unit scale that puts typical values in the 1-1000 range (wall_ms=14, not wall_seconds=0.014).',
				},
				metric_unit: {
					type: 'string',
					description: 'Display unit, e.g. "ms", "µs", "kb". Default: unitless.',
				},
				direction: { type: 'string', enum: ['lower', 'higher'] },
			},
			required: ['working_dir', 'name', 'metric_name'],
		},
		execute: executeInit,
	})
	amp.registerTool({
		name: 'run_experiment',
		description: 'Run .auto/measure.sh, parse METRIC lines, and optionally run .auto/checks.sh.',
		inputSchema: {
			type: 'object',
			properties: {
				timeout_seconds: { type: 'number' },
				checks_timeout_seconds: { type: 'number' },
			},
		},
		execute: executeRun,
	})
	amp.registerTool({
		name: 'log_experiment',
		description:
			'Log an experiment result, commit kept changes, or revert discarded/crashed changes.',
		inputSchema: {
			type: 'object',
			properties: {
				commit: { type: 'string' },
				metric: { type: 'number' },
				status: { type: 'string', enum: ['keep', 'discard', 'crash', 'checks_failed'] },
				description: { type: 'string' },
				metrics: { type: 'object', additionalProperties: { type: 'number' } },
				force: { type: 'boolean' },
				asi: { type: 'object' },
			},
			required: ['commit', 'metric', 'status', 'description'],
		},
		execute: executeLog,
	})

	const notify = async (ctx: { ui: { notify: (m: string) => Promise<void> } }, message: string) => {
		try {
			await ctx.ui.notify(message)
		} catch {
			amp.logger.log(message)
		}
	}

	amp.on('agent.start', (event) => {
		try {
			return agentStart(event)
		} catch (e) {
			amp.logger.log(`autoresearch agent.start failed: ${e}`)
			return {}
		}
	})

	const agentStart = (event: { thread: { id: string }; message: string }) => {
		const found = sessionForThread(event.thread.id)
		if (!found) return {}
		const { workdir, session } = found
		// A genuine user message resets the auto-resume budget.
		if (!isResumeMessage(event.message) && session.autoResumeTurns !== 0) {
			try {
				writeSessionFile(workdir, { ...session, autoResumeTurns: 0 })
			} catch (e) {
				amp.logger.log(`autoresearch: failed to reset resume cap: ${e}`)
			}
		}
		// Resume messages already carry the digest; only user-originated turns need it.
		if (isResumeMessage(event.message)) return {}
		if (!fs.existsSync(logPath(workdir))) return {}
		try {
			const state = reconstructJsonlState(fs.readFileSync(logPath(workdir), 'utf-8'))
			return {
				message: {
					content: `<${STATE_TAG}>\n${buildDigest(state)}\n</${STATE_TAG}>`,
					display: false,
				},
			}
		} catch {
			return {}
		}
	}

	amp.on('agent.end', async (event, ctx) => {
		try {
			return await agentEnd(event, ctx)
		} catch (e) {
			amp.logger.log(`autoresearch agent.end failed: ${e}`)
		}
	})

	const agentEnd = async (
		event: {
			thread: { id: string }
			status: 'done' | 'error' | 'cancelled'
			messages: Parameters<typeof amp.helpers.toolCallsInMessages>[0]
		},
		ctx: { ui: { notify: (m: string) => Promise<void> } },
	) => {
		const found = sessionForThread(event.thread.id)
		if (!found) return
		const { workdir, session } = found
		const decision = decideContinue({
			session,
			workdir,
			turnStatus: event.status,
			turnLoggedExperiment: turnLoggedExperiment(amp.helpers.toolCallsInMessages(event.messages)),
			maxTurns: readMaxAutoResumeTurns(workdir),
		})
		switch (decision.action) {
			case 'continue':
				writeSessionFile(workdir, { ...session, autoResumeTurns: session.autoResumeTurns + 1 })
				return { action: 'continue' as const, userMessage: decision.userMessage! }
			case 'stop-stranded':
				deactivateSession(workdir)
				await notify(ctx, decision.notice!)
				return
			case 'stop-cap':
				await notify(ctx, decision.notice!)
				return
			case 'none':
				return
		}
	}

	// ── Commands ──

	amp.registerCommand(
		'autoresearch-start',
		{
			title: 'Start',
			category: 'Autoresearch',
			description: 'Start (or resume) an autonomous experiment loop in the current thread',
		},
		async (ctx) => {
			try {
				if (!ctx.thread) {
					await ctx.ui.notify('Autoresearch: open a thread first, then run this command.')
					return
				}
				// process.cwd() is the plugin host's cwd (not the workspace), so it
				// makes a misleading default; prefer the thread's bound session.
				const bound = sessionForThread(ctx.thread.id)
				const workdirInput = await ctx.ui.input({
					title: 'Autoresearch working directory',
					helpText: 'Absolute path to the git repository to experiment in.',
					initialValue: bound?.workdir ?? '',
				})
				if (!workdirInput) return
				const workdir = path.resolve(workdirInput.trim())
				if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
					await ctx.ui.notify(`Autoresearch: ${workdir} is not a directory.`)
					return
				}
				const other = readSessionFile(workdir)
				if (other?.active && other.threadID !== ctx.thread.id) {
					await ctx.ui.notify(
						`Autoresearch: session in ${workdir} is held by thread ${other.threadID}. Stop it there first (or init_experiment here to take over).`,
					)
					return
				}
				const hasPrompt = fs.existsSync(promptPath(workdir))
				let kickoff: string
				if (hasPrompt) {
					kickoff = buildResumeKickoff(workdir)
				} else {
					const goal = await ctx.ui.input({
						title: 'What should autoresearch optimize?',
						helpText: 'One sentence, e.g. "make the JSON parser benchmark faster".',
					})
					if (!goal) return
					kickoff = buildCreateKickoff(goal.trim(), workdir)
				}
				try {
					await ctx.thread.appendUserMessage({ type: 'user-message', content: kickoff })
					await ctx.ui.notify(
						hasPrompt
							? 'Autoresearch: resume kickoff sent — the loop continues from .auto/prompt.md.'
							: 'Autoresearch: kickoff sent — the agent will set up .auto/ and start looping.',
					)
				} catch {
					// Spike finding: appendUserMessage needs an active thread; fall back to manual paste.
					await ctx.ui.notify(
						'Autoresearch: could not append to this thread. Paste this to start:\n\n' + kickoff,
					)
				}
			} catch (e) {
				amp.logger.log(`autoresearch-start failed: ${e}`)
			}
		},
	)

	amp.registerCommand(
		'autoresearch-stop',
		{
			title: 'Stop',
			category: 'Autoresearch',
			description: "Deactivate the current thread's autoresearch session",
		},
		async (ctx) => {
			const found = ctx.thread && sessionForThread(ctx.thread.id)
			if (!found) {
				await ctx.ui.notify('Autoresearch: no active session for this thread.')
				return
			}
			deactivateSession(found.workdir)
			await ctx.ui.notify(`Autoresearch: session in ${found.workdir} stopped.`)
		},
	)

	amp.registerCommand(
		'autoresearch-clear',
		{
			title: 'Clear log',
			category: 'Autoresearch',
			description: "Delete the current thread's .auto/log.jsonl and deactivate the session",
		},
		async (ctx) => {
			const found = ctx.thread && sessionForThread(ctx.thread.id)
			if (!found) {
				await ctx.ui.notify('Autoresearch: no active session for this thread.')
				return
			}
			const ok = await ctx.ui
				.confirm({
					title: 'Clear autoresearch log?',
					message: `Deletes ${logPath(found.workdir)} and deactivates the session. Kept commits stay in git.`,
				})
				.catch(() => false)
			if (!ok) return
			try {
				fs.rmSync(logPath(found.workdir), { force: true })
			} catch (e) {
				amp.logger.log(`autoresearch-clear failed: ${e}`)
			}
			deactivateSession(found.workdir)
			await ctx.ui.notify('Autoresearch: log cleared, session deactivated.')
		},
	)

	amp.registerCommand(
		'autoresearch-dashboard',
		{
			title: 'Dashboard',
			category: 'Autoresearch',
			description: 'Open the live browser dashboard for the current thread’s session',
		},
		async (ctx) => {
			const found = ctx.thread && sessionForThread(ctx.thread.id)
			if (!found) {
				await ctx.ui.notify('Autoresearch: no active session for this thread.')
				return
			}
			try {
				const url = startDashboard(found.workdir)
				await ctx.system.open(url)
			} catch (e) {
				amp.logger.log(`autoresearch-dashboard failed: ${e}`)
				await ctx.ui.notify(`Autoresearch: could not open dashboard: ${e}`)
			}
		},
	)

	// ── Status item (experimental API; absent hosts degrade to nothing) ──

	try {
		const statusItem = amp.experimental?.createStatusItem?.()
		if (statusItem) {
			onExperimentLogged = (workdir) => {
				const lp = logPath(workdir)
				if (!fs.existsSync(lp)) return
				const state = reconstructJsonlState(fs.readFileSync(lp, 'utf-8'))
				const runs = currentResults(state.results, state.currentSegment)
				const best = bestMetric(runs, state.bestDirection)
				const baseline = findBaselineMetric(state.results, state.currentSegment)
				const confidence = computeConfidence(
					state.results,
					state.currentSegment,
					state.bestDirection,
				)
				statusItem.update({
					text: [
						`🔬 ${runs.length} runs`,
						best !== null
							? `best ${formatNum(best, state.metricUnit)}${formatDelta(best, baseline)}`
							: '',
						confidence !== null ? `conf ${confidence.toFixed(1)}×` : '',
					]
						.filter(Boolean)
						.join(' · '),
					url: 'command:autoresearch-dashboard',
				})
			}
		}
	} catch (e) {
		amp.logger.log(`autoresearch: status item unavailable: ${e}`)
	}

	amp.registerCommand(
		'autoresearch-status',
		{
			title: 'Status',
			category: 'Autoresearch',
			description: 'Show the state of the autoresearch session for the current thread',
		},
		async (ctx) => {
			const found = ctx.thread && sessionForThread(ctx.thread.id)
			if (!found) {
				await ctx.ui.notify('Autoresearch: no active session for this thread.')
				return
			}
			const lp = logPath(found.workdir)
			const state = reconstructJsonlState(fs.existsSync(lp) ? fs.readFileSync(lp, 'utf-8') : '')
			await ctx.ui.notify(
				`Autoresearch (${found.workdir}) — resumes used: ${found.session.autoResumeTurns}/${readMaxAutoResumeTurns(found.workdir)}\n${buildDigest(state)}`,
			)
		},
	)

	amp.logger.log('amp-autoresearch loaded')
}
