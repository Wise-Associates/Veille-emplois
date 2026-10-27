import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { HttpClient } from '../http/http-client.js'
import { organisationsFrom } from '../organisations.js'
import { DEFAULT_SETTINGS } from '../settings/defaults.js'
import type { VeilleSettings } from '../settings/veille-settings.js'
import { createSources } from './sources.js'

// Aucune source ne lit quoi que ce soit à sa création : un client HTTP factice suffit.
const http = {} as HttpClient
const clock = { now: () => new Date('2026-10-27T05:00:00Z') }
const idsFor = (settings: VeilleSettings) => createSources(http, clock, settings, organisationsFrom(settings)).map((s) => s.id)
const edit = (patch: (s: VeilleSettings) => void): VeilleSettings => {
  const copy = structuredClone(DEFAULT_SETTINGS)
  patch(copy)
  return copy
}

describe('sources d\'un passage, d\'après les réglages', () => {
  it('garde les identifiants du fichier d\'état et lit BOAMP avant TED', () => {
    const ids = idsFor(edit((s) => { s.sources.reverse() }))
    assert.deepEqual(ids.slice(0, 2), ['boamp', 'ted'])
    for (const id of ['csp-dgfip', 'csp-autorite-concurrence', 'sfil-carrieres', 'expertise-france-carrieres', 'banque-postale-carrieres', 'afd-carrieres', 'crh-site']) {
      assert.ok(ids.includes(id), id)
    }
  })

  it('ne lit ni une source désactivée, ni celles d\'un organisme désactivé (site intégré compris)', () => {
    const ids = idsFor(edit((s) => {
      const ted = s.sources.find((source) => source.id === 'ted')
      if (ted) ted.enabled = false
      for (const organisation of s.organisations) if (organisation.id === 'insee' || organisation.id === 'proparco') organisation.enabled = false
    }))
    assert.ok(!ids.includes('ted'))
    assert.ok(!ids.includes('csp-insee'), 'organisme désactivé')
    assert.ok(!ids.includes('afd-carrieres'), 'site intégré de Proparco')
    assert.ok(ids.includes('csp-dgfip'))
  })

  it('ne lit ni le BOAMP ni TED quand aucun organisme n\'est suivi pour ses appels d\'offres', () => {
    const ids = idsFor(edit((s) => { for (const organisation of s.organisations) organisation.tenderRules = [] }))
    assert.ok(!ids.includes('boamp') && !ids.includes('ted'))
    assert.ok(ids.includes('csp-dgfip'))
  })

  it('crée une source ajoutée dans les réglages, avec son propre identifiant', () => {
    const sources = createSources(http, clock, edit((s) => {
      s.sources.push({ kind: 'rss', id: 'insee-carrieres', enabled: true, organisationId: 'insee', label: 'INSEE — flux fictif', url: 'https://carrieres.exemple.test/feed', readOfferPage: true })
      s.sources.push({ kind: 'csp', id: 'csp-insee-2', enabled: true, organisationId: 'insee', label: 'Choisir le service public — INSEE bis', codes: ['12345'] })
    }), organisationsFrom(DEFAULT_SETTINGS))
    const feed = sources.find((s) => s.id === 'insee-carrieres')
    assert.equal(feed?.label, 'INSEE — flux fictif')
    assert.ok(feed?.describe, 'lecture de la page de chaque offre')
    assert.ok(sources.some((s) => s.id === 'csp-insee-2'))
  })
})
