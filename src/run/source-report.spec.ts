import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Listing } from '../listing.js'
import type { NewListing, SourceOutcome } from '../state/run-state.js'
import { buildRunReport, MAX_MESSAGE_LENGTH, type RunFacts } from './source-report.js'
import { reportUrl } from './source-report-sender.js'

const listing = (sourceId: string, id: string): NewListing => ({
  kind: 'tender', id, organisationId: 'dinum', title: `Avis fictif ${id}`, url: `https://exemple.test/${id}`, details: [], sourceId,
})
const listed = (id: string): Listing => ({ kind: 'tender', id, organisationId: 'dinum', title: `Avis fictif ${id}`, url: 'https://exemple.test', details: [] })

const facts = (overrides: Partial<RunFacts> = {}): RunFacts => ({
  startedAt: new Date('2026-11-10T09:00:00Z'),
  finishedAt: new Date('2026-11-10T09:04:00Z'),
  settings: { origin: 'remote', snapshot: { version: 12, savedAt: '2026-11-09T08:00:00Z', value: {} } },
  outcomes: [],
  outOfScopeBySource: new Map(),
  newListings: [],
  sent: [],
  outdated: [],
  deliveryError: null,
  warnings: [],
  ...overrides,
})

describe('rapport du passage pour le suivi des sources', () => {
  it('rattache chaque alerte à sa source par son libellé, les autres vont à part', () => {
    const outcomes: SourceOutcome[] = [
      { sourceId: 'boamp', label: 'BOAMP', kind: 'tender', ok: true, batch: { listings: [listed('1'), listed('2')], ignoredIds: [] } },
    ]
    const report = buildRunReport(facts({
      outcomes,
      warnings: [
        { label: 'BOAMP', message: '2 offre(s) envoyée(s) sans l\'avis officiel en PDF' },
        { label: "Fichier d'état", message: 'Copie du jour impossible' },
      ],
    }))
    assert.deepEqual(report.sources[0]?.warnings, ['2 offre(s) envoyée(s) sans l\'avis officiel en PDF'])
    assert.deepEqual(report.otherWarnings, [{ label: "Fichier d'état", message: 'Copie du jour impossible' }])
  })

  it('compte nouvelles, envoyées, échues et en attente par source', () => {
    const fresh = [listing('ted', 'T1'), listing('ted', 'T2'), listing('ted', 'T3'), listing('boamp', 'B1')]
    const report = buildRunReport(facts({
      outcomes: [
        { sourceId: 'ted', label: 'TED', kind: 'tender', ok: true, batch: { listings: [listed('T1'), listed('T2'), listed('T3')], ignoredIds: [] } },
        { sourceId: 'boamp', label: 'BOAMP', kind: 'tender', ok: true, batch: { listings: [listed('B1')], ignoredIds: [] } },
      ],
      outOfScopeBySource: new Map([['ted', 4]]),
      newListings: fresh,
      sent: [fresh[0] as NewListing],
      outdated: [fresh[1] as NewListing],
    }))
    assert.deepEqual(
      report.sources.map(({ id, listed, outOfScope, new: created, sent, outdated, pending }) => ({ id, listed, outOfScope, created, sent, outdated, pending })),
      [
        { id: 'ted', listed: 3, outOfScope: 4, created: 3, sent: 1, outdated: 1, pending: 1 },
        { id: 'boamp', listed: 1, outOfScope: 0, created: 1, sent: 0, outdated: 0, pending: 1 },
      ],
    )
  })

  it('coupe les messages trop longs et ne donne pas de version pour les réglages du dépôt', () => {
    const long = 'x'.repeat(MAX_MESSAGE_LENGTH + 50)
    const report = buildRunReport(facts({
      settings: { origin: 'defaults', snapshot: { version: 3, savedAt: '2026-11-01T00:00:00Z', value: {} } },
      outcomes: [{ sourceId: 'csp-dgfip', label: 'DGFiP', kind: 'job', ok: false, error: long }],
      deliveryError: long,
    }))
    assert.deepEqual(report.settings, { origin: 'defaults', version: null })
    assert.equal(report.sources[0]?.error?.length, MAX_MESSAGE_LENGTH)
    assert.equal(report.deliveryError?.length, MAX_MESSAGE_LENGTH)
    assert.equal(report.startedAt, '2026-11-10T09:00:00.000Z')
  })
})

describe('adresse des rapports de passage', () => {
  it('se trouve à côté de la route des réglages', () => {
    assert.equal(reportUrl('https://mbc.exemple.test/api/veille/config'), 'https://mbc.exemple.test/api/veille/runs')
    assert.equal(reportUrl('http://localhost:3000/api/veille/config/'), 'http://localhost:3000/api/veille/runs')
  })

  it('refuse une adresse des réglages qui ne finit pas par /config', () => {
    assert.throws(() => reportUrl('https://mbc.exemple.test/api/veille/reglages'), /ne finit pas par \/config/)
  })
})
