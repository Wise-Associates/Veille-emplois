import 'reflect-metadata'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Logger } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { CLOCK } from './clock.js'
import { APP_CONFIG, type AppConfig } from './config.js'
import type { Digest } from './digest/digest.js'
import type { Listing, ListingSource } from './listing.js'
import { Mailer } from './mail/mailer.js'
import { ScanService } from './scan.service.js'
import { LISTING_SOURCES } from './sources/sources.js'
import { EMPTY_STATE, type VeilleState } from './state/run-state.js'
import { StateStore } from './state/state-store.js'

Logger.overrideLogger(false)

const offer = (id: string): Listing => ({ kind: 'job', id, organisationId: 'dinum', title: `Offre fictive ${id}`, url: `https://exemple.test/${id}`, details: [] })

const source = (id: string, fetch: ListingSource['fetch']): ListingSource => ({ id, label: `Source ${id}`, kind: 'job', fetch })

const known: VeilleState = {
  ...EMPTY_STATE,
  sources: {
    a: { seen: { A1: '2026-10-21' }, lastCount: 1, lastSuccessOn: '2026-10-21' },
    b: { seen: {}, lastCount: 0, lastSuccessOn: '2026-10-21' },
  },
}

async function scanWith(options: { sources: ListingSource[]; send?: (digest: Digest) => Promise<void>; dryRun?: boolean }) {
  const calls: string[] = []
  const sent: Digest[] = []
  const saved: VeilleState[] = []
  const config: AppConfig = { stateFile: 'inutilise.json', dryRun: options.dryRun ?? false, mail: null }
  const module = await Test.createTestingModule({
    providers: [
      ScanService,
      { provide: LISTING_SOURCES, useValue: options.sources },
      { provide: CLOCK, useValue: { now: () => new Date('2026-10-22T05:00:00Z') } },
      { provide: APP_CONFIG, useValue: config },
      { provide: StateStore, useValue: { load: async () => known, save: async (state: VeilleState) => (calls.push('save'), saved.push(state)) } },
      {
        provide: Mailer,
        useValue: { send: async (digest: Digest) => (calls.push('send'), await (options.send?.(digest) ?? Promise.resolve()), sent.push(digest)) },
      },
    ],
  }).compile()
  return { scan: module.get(ScanService), calls, sent, saved }
}

describe('passage de la veille', () => {
  it('envoie le récapitulatif des nouveautés, puis seulement retient l\'état', async () => {
    const { scan, calls, sent, saved } = await scanWith({ sources: [source('a', async () => ({ listings: [offer('A1'), offer('A2')], ignoredIds: [] }))] })
    const report = await scan.run()
    assert.deepEqual(report.newListings.map((l) => l.id), ['A2'])
    assert.deepEqual(calls, ['send', 'save'])
    assert.match(sent[0]?.subject ?? '', /1 offre d'emploi/)
    assert.deepEqual(Object.keys(saved[0]?.sources['a']?.seen ?? {}).sort(), ['A1', 'A2'])
  })

  it('ne retient pas l\'état si l\'envoi échoue : les nouveautés seront annoncées au passage suivant', async () => {
    const { scan, calls } = await scanWith({
      sources: [source('a', async () => ({ listings: [offer('A2')], ignoredIds: [] }))],
      send: async () => {
        throw new Error('SMTP indisponible')
      },
    })
    await assert.rejects(scan.run(), /SMTP indisponible/)
    assert.deepEqual(calls, ['send'])
  })

  it('poursuit après une source en échec et la signale dans le récapitulatif', async () => {
    const { scan, sent } = await scanWith({
      sources: [
        source('a', async () => {
          throw new Error('HTTP 503 sur https://exemple.test/flux')
        }),
        source('b', async () => ({ listings: [offer('B1')], ignoredIds: [] })),
      ],
    })
    const report = await scan.run()
    assert.deepEqual(report.newListings.map((l) => l.id), ['B1'])
    assert.match(sent[0]?.text ?? '', /Source a : HTTP 503/)
  })

  it('indique à chaque source ce qu\'elle a déjà vu', async () => {
    const contexts: { firstRun: boolean; a1: boolean }[] = []
    const record: ListingSource['fetch'] = async (context) => (contexts.push({ firstRun: context.firstRun, a1: context.isKnown('A1') }), { listings: [], ignoredIds: [] })
    const { scan } = await scanWith({ sources: [source('a', record), source('nouvelle', record)] })
    await scan.run()
    assert.deepEqual(contexts, [{ firstRun: false, a1: true }, { firstRun: true, a1: false }])
  })

  it('en essai, n\'envoie rien et ne retient rien', async () => {
    const { scan, calls } = await scanWith({ sources: [source('a', async () => ({ listings: [offer('A2')], ignoredIds: [] }))], dryRun: true })
    await scan.run()
    assert.deepEqual(calls, [])
  })
})
