import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS } from './defaults.js'
import { chooseSettings, isPublicHttpsUrl, parseVeilleSettings, type VeilleSettings } from './veille-settings.js'

const settings = (patch: (s: VeilleSettings) => void = () => {}): VeilleSettings => {
  const copy = structuredClone(DEFAULT_SETTINGS)
  patch(copy)
  return copy
}

describe('réglages de la veille', () => {
  it('lit les réglages par défaut du dépôt (config/defaults.json), avec les identifiants de sources du fichier d\'état', () => {
    assert.ok(DEFAULT_SETTINGS.organisations.some((o) => o.id === 'dgfip'))
    const ids = DEFAULT_SETTINGS.sources.map((s) => s.id)
    for (const id of ['boamp', 'ted', 'csp-dgfip', 'sfil-carrieres', 'expertise-france-carrieres', 'afd-carrieres', 'crh-site']) {
      assert.ok(ids.includes(id), id)
    }
  })

  it('refuse une source dont l\'organisme manque, un identifiant en double et un autre format', () => {
    const orphan = settings((s) => {
      s.sources.push({ kind: 'csp', id: 'csp-fictif', enabled: true, organisationId: 'inconnu', label: 'Fictif', codes: ['1'] })
    })
    assert.match(String(!parseVeilleSettings(orphan).success && (parseVeilleSettings(orphan) as { error: string }).error), /inconnu/)
    const duplicate = settings((s) => {
      const csp = s.sources.find((source) => source.id === 'csp-dgfip')
      if (csp) s.sources.push({ ...csp })
    })
    assert.equal(parseVeilleSettings(duplicate).success, false)
    assert.equal(parseVeilleSettings({ ...settings(), schemaVersion: 2 }).success, false)
  })

  it('met les expressions sous leur forme comparée dès la validation', () => {
    const parsed = parseVeilleSettings(settings((s) => { s.itScope.phrases = ['Système d’Information', 'x" OR 1=1'] }))
    assert.ok(parsed.success)
    assert.deepEqual(parsed.success && parsed.settings.itScope.phrases, ['systeme d information', 'x or 1 1'])
  })

  it('n\'accepte comme adresse de flux, ou de redirection, qu\'un nom de domaine public en https', () => {
    assert.equal(isPublicHttpsUrl('https://carrieres.exemple.fr/feed'), true)
    for (const url of ['http://carrieres.exemple.fr/feed', 'https://127.0.0.1/feed', 'https://localhost/feed', 'https://user:pw@exemple.fr/', 'https://[::1]/', 'pas une adresse']) {
      assert.equal(isPublicHttpsUrl(url), false, url)
    }
  })

  it('refuse une adresse de flux hors https et une expression vide', () => {
    const http = settings((s) => {
      s.sources.push({ kind: 'rss', id: 'flux-fictif', enabled: true, organisationId: 'dgfip', label: 'Fictif', url: 'http://exemple.test/feed', readOfferPage: false })
    })
    assert.equal(parseVeilleSettings(http).success, false)
    assert.equal(parseVeilleSettings(settings((s) => { s.itScope.phrases.push('***') })).success, false)
  })
})

describe('choix des réglages au début d\'un passage', () => {
  const remote = settings((s) => { s.itScope.enabled = false })
  const snapshot = { version: 4, savedAt: '2026-10-26T08:00:00.000Z', value: settings((s) => { s.itScope.cpvPrefixes = ['72'] }) }

  it('prend ceux de MyBestConsultant et les garde comme dernière version connue', () => {
    const chosen = chooseSettings({ remote: { ok: true, version: 5, savedAt: '2026-10-27T09:00:00.000Z', value: remote }, snapshot, defaults: DEFAULT_SETTINGS })
    assert.equal(chosen.origin, 'remote')
    assert.equal(chosen.settings.itScope.enabled, false)
    assert.equal(chosen.warning, null)
    assert.deepEqual(chosen.snapshot, { version: 5, savedAt: '2026-10-27T09:00:00.000Z', value: remote })
  })

  it('MyBestConsultant injoignable : dernière version connue, signalée, et gardée telle quelle', () => {
    const chosen = chooseSettings({ remote: { ok: false, error: 'HTTP 503' }, snapshot, defaults: DEFAULT_SETTINGS })
    assert.equal(chosen.origin, 'snapshot')
    assert.deepEqual(chosen.settings.itScope.cpvPrefixes, ['72'])
    assert.match(chosen.warning ?? '', /HTTP 503.*version 4 du 26\/10\/2026/)
    assert.equal(chosen.snapshot, snapshot)
  })

  it('sans dernière version lisible : réglages du dépôt, signalés', () => {
    for (const bad of [undefined, { version: 1, savedAt: 'x', value: { schemaVersion: 1 } }]) {
      const chosen = chooseSettings({ remote: { ok: false, error: 'délai dépassé' }, snapshot: bad, defaults: DEFAULT_SETTINGS })
      assert.equal(chosen.origin, 'defaults')
      assert.match(chosen.warning ?? '', /délai dépassé.*réglages du dépôt/)
    }
  })

  it('réglages de MyBestConsultant invalides : traités comme injoignables', () => {
    const chosen = chooseSettings({ remote: { ok: true, version: 6, savedAt: '2026-10-27T09:00:00.000Z', value: { schemaVersion: 2 } }, snapshot, defaults: DEFAULT_SETTINGS })
    assert.equal(chosen.origin, 'snapshot')
    assert.match(chosen.warning ?? '', /\(version 6\) illisibles/)
  })

  it('lecture non configurée (essai local) : réglages du dépôt, signalés', () => {
    const chosen = chooseSettings({ remote: null, snapshot, defaults: DEFAULT_SETTINGS })
    assert.equal(chosen.origin, 'defaults')
    assert.match(chosen.warning ?? '', /VEILLE_CONFIG_URL/)
  })
})
