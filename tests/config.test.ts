import { describe, expect, test } from 'claude-code/testing'

import { configOf } from '../hooks/lib/config'
import { DEFAULT_CONFIG } from '../hooks/lib/model'

const read = (value: unknown) => configOf(JSON.stringify(value))

describe('config', () => {
  test('no file, or an empty object, gives the defaults', async () => {
    expect(configOf(null)).toEqual({ config: DEFAULT_CONFIG, problems: [] })
    expect(read({})).toEqual({ config: DEFAULT_CONFIG, problems: [] })
  })

  test('a list replaces the default whole; an object key by key', async () => {
    const { config, problems } = read({
      columns: { triage: ['inbox', 'new'] },
      containers: ['epic'],
      launch: [{ label: 'inbox', prompt: '/triage #{n}' }],
      branchPatterns: { issue: 'gh-(\\d+)' },
      doneDays: 14,
      refreshSeconds: 30,
    })

    expect(problems).toEqual([])
    expect(config.columns).toEqual({ ...DEFAULT_CONFIG.columns, triage: ['inbox', 'new'] })
    expect(config.containers).toEqual(['epic'])
    expect(config.launch).toEqual([{ label: 'inbox', prompt: '/triage #{n}' }])
    expect(config.branchPatterns).toEqual({ ...DEFAULT_CONFIG.branchPatterns, issue: 'gh-(\\d+)' })
    expect([config.doneDays, config.refreshSeconds]).toEqual([14, 30])
  })

  test('a wrong part keeps its default and is named; a wrong launch rule is left out', async () => {
    const { config, problems } = read({
      columns: { triage: 'needs-triage', backlog: ['x'] },
      containers: [1],
      launch: [{ prompt: 'no label' }, { labelPrefix: 'wayfinder:', prompt: '/wayfinder #{n}' }, { label: 'x', prompt: '' }],
      branchPatterns: { issue: '(', fallback: '-\\d+$' },
      doneDays: 0,
      refreshSeconds: 5,
      theme: 'dark',
    })

    expect(problems).toEqual([
      'theme is not a setting of the board',
      'columns.backlog is not a setting of the board',
      'columns.triage must be a list of label names',
      'containers must be a list of label names',
      'launch[0] needs label or labelPrefix',
      'launch[2].prompt must be the text the session starts with',
      'branchPatterns.issue must be a regular expression',
      'branchPatterns.fallback needs a group, such as (\\d+), around the issue number',
      'doneDays must be a whole number from 1 to 365',
      'refreshSeconds must be a whole number from 15 to 3600',
    ])
    expect(config.columns).toEqual(DEFAULT_CONFIG.columns)
    expect(config.containers).toEqual(DEFAULT_CONFIG.containers)
    expect(config.launch).toEqual([{ labelPrefix: 'wayfinder:', prompt: '/wayfinder #{n}' }])
    expect(config.branchPatterns).toEqual(DEFAULT_CONFIG.branchPatterns)
    expect([config.doneDays, config.refreshSeconds]).toEqual([7, 60])
  })

  test('text that is not a JSON object gives the defaults and says so', async () => {
    expect(configOf('{').config).toEqual(DEFAULT_CONFIG)
    expect(configOf('{').problems[0]).toMatch(/^it is not JSON \(/)
    expect(configOf('[]')).toEqual({ config: DEFAULT_CONFIG, problems: ['it is not a JSON object'] })
  })
})
