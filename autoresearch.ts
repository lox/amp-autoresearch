import * as fs from 'node:fs'
import * as path from 'node:path'
import type { PluginAPI } from '@ampcode/plugin'

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

export default function (amp: PluginAPI) {
	amp.logger.log('amp-autoresearch loaded (slice 1: core only)')
}
