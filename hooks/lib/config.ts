// The repository's `.claude/kanban.json` over the defaults (spec section 10).
// Each part the file gives replaces the default's: a list whole, an object key
// by key. A part that is wrong keeps the default (a wrong launch rule is left
// out) and is named in `problems`.
// Pure: no `$`, so the tests run it directly.

import type { LaunchRule } from './launch'
import { DEFAULT_CONFIG, type Config } from './model'

/** Where the file is, from the root of the worktree the session runs in. */
export const CONFIG_PATH = '.claude/kanban.json'

/** How often the board may ask GitHub: each refresh is several queries. */
export const REFRESH_SECONDS = { min: 15, max: 3600 }
export const DONE_DAYS = { min: 1, max: 365 }

export type ConfigRead = { config: Config; problems: string[] }

type Problems = string[]

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string' && item !== '')

/** The keys of `value` that `known` does not have, each a problem. */
function unknownKeys(value: Record<string, unknown>, known: readonly string[], at: string, problems: Problems) {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) problems.push(`${at}${key} is not a setting of the board`)
  }
}

function listOf(value: unknown, fallback: string[], at: string, problems: Problems): string[] {
  if (value === undefined) return fallback
  if (isStringList(value)) return value
  problems.push(`${at} must be a list of label names`)
  return fallback
}

function columnsOf(value: unknown, problems: Problems): Config['columns'] {
  const fallback = DEFAULT_CONFIG.columns
  if (value === undefined) return fallback
  if (!isObject(value)) {
    problems.push('columns must be an object of label lists')
    return fallback
  }
  const keys = Object.keys(fallback) as (keyof Config['columns'])[]
  unknownKeys(value, keys, 'columns.', problems)
  return Object.fromEntries(
    keys.map(key => [key, listOf(value[key], fallback[key], `columns.${key}`, problems)]),
  ) as Config['columns']
}

const RULE_KEYS = ['label', 'labelPrefix', 'parentLabel', 'prompt'] as const

/** One `launch` rule, or null (with the problem) when it is wrong. */
function ruleOf(value: unknown, at: string, problems: Problems): LaunchRule | null {
  if (!isObject(value)) {
    problems.push(`${at} must be an object with a prompt`)
    return null
  }
  unknownKeys(value, RULE_KEYS, `${at}.`, problems)
  if (typeof value.prompt !== 'string' || value.prompt.trim() === '') {
    problems.push(`${at}.prompt must be the text the session starts with`)
    return null
  }
  const rule: LaunchRule = { prompt: value.prompt }
  for (const key of ['label', 'labelPrefix', 'parentLabel'] as const) {
    const part = value[key]
    if (part === undefined) continue
    if (typeof part !== 'string' || part === '') {
      problems.push(`${at}.${key} must be a label name`)
      return null
    }
    rule[key] = part
  }
  if (rule.label === undefined && rule.labelPrefix === undefined) {
    problems.push(`${at} needs label or labelPrefix`)
    return null
  }
  return rule
}

function launchOf(value: unknown, problems: Problems): LaunchRule[] {
  if (value === undefined) return DEFAULT_CONFIG.launch
  if (!Array.isArray(value)) {
    problems.push('launch must be a list of rules')
    return DEFAULT_CONFIG.launch
  }
  // A wrong rule is left out; the others keep their order.
  return value.flatMap((one, index) => ruleOf(one, `launch[${index}]`, problems) ?? [])
}

/** How many capture groups `pattern` has; null when it does not compile. */
function groupsOf(pattern: string): number | null {
  try {
    return (new RegExp(`${pattern}|`).exec('')?.length ?? 1) - 1
  } catch {
    return null
  }
}

function patternsOf(value: unknown, problems: Problems): Config['branchPatterns'] {
  const fallback = DEFAULT_CONFIG.branchPatterns
  if (value === undefined) return fallback
  if (!isObject(value)) {
    problems.push('branchPatterns must be an object of regular expressions')
    return fallback
  }
  const keys = Object.keys(fallback) as (keyof Config['branchPatterns'])[]
  unknownKeys(value, keys, 'branchPatterns.', problems)
  return Object.fromEntries(
    keys.map(key => {
      const pattern = value[key]
      if (pattern === undefined) return [key, fallback[key]]
      const groups = typeof pattern === 'string' ? groupsOf(pattern) : null
      if (groups === null) {
        problems.push(`branchPatterns.${key} must be a regular expression`)
        return [key, fallback[key]]
      }
      if (groups < 1) {
        problems.push(`branchPatterns.${key} needs a group, such as (\\d+), around the issue number`)
        return [key, fallback[key]]
      }
      return [key, pattern]
    }),
  ) as Config['branchPatterns']
}

function wholeOf(value: unknown, fallback: number, range: { min: number; max: number }, at: string, problems: Problems) {
  if (value === undefined) return fallback
  if (typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max) return value
  problems.push(`${at} must be a whole number from ${range.min} to ${range.max}`)
  return fallback
}

const KEYS = ['columns', 'containers', 'launch', 'branchPatterns', 'doneDays', 'refreshSeconds'] as const

/** The config from the file's text; null (no file) gives the defaults. */
export function configOf(text: string | null): ConfigRead {
  if (text === null) return { config: DEFAULT_CONFIG, problems: [] }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { config: DEFAULT_CONFIG, problems: [`it is not JSON (${error instanceof Error ? error.message : String(error)})`] }
  }
  if (!isObject(value)) return { config: DEFAULT_CONFIG, problems: ['it is not a JSON object'] }

  const problems: Problems = []
  unknownKeys(value, KEYS, '', problems)
  const config: Config = {
    columns: columnsOf(value.columns, problems),
    containers: listOf(value.containers, DEFAULT_CONFIG.containers, 'containers', problems),
    launch: launchOf(value.launch, problems),
    branchPatterns: patternsOf(value.branchPatterns, problems),
    doneDays: wholeOf(value.doneDays, DEFAULT_CONFIG.doneDays, DONE_DAYS, 'doneDays', problems),
    refreshSeconds: wholeOf(value.refreshSeconds, DEFAULT_CONFIG.refreshSeconds, REFRESH_SECONDS, 'refreshSeconds', problems),
  }
  return { config, problems }
}
