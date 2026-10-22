import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Listing } from '../listing.js'
import { applyRun, EMPTY_STATE, type SourceOutcome, type VeilleState } from './run-state.js'

const today = '2026-10-22'

const job = (id: string): Listing => ({
  kind: 'job',
  id,
  organisationId: 'dinum',
  title: `Offre fictive ${id}`,
  url: `https://exemple.test/offres/${id}`,
  details: [],
})

const tender = (id: string, procedureId?: string): Listing => ({
  kind: 'tender',
  id,
  organisationId: 'insee',
  title: `Marché fictif ${id}`,
  url: `https://exemple.test/avis/${id}`,
  details: [],
  procedureId,
})

const ok = (sourceId: string, listings: Listing[], ignoredIds: string[] = [], kind: 'job' | 'tender' = 'job'): SourceOutcome => ({
  sourceId,
  label: `Source ${sourceId}`,
  kind,
  ok: true,
  batch: { listings, ignoredIds },
})

const stateWith = (sourceId: string, seen: Record<string, string>, lastCount = Object.keys(seen).length): VeilleState => ({
  ...EMPTY_STATE,
  sources: { [sourceId]: { seen, lastCount, lastSuccessOn: '2026-10-21' } },
})

describe('repérage des nouvelles annonces', () => {
  it('enregistre sans les annoncer les annonces d\'une source lue pour la première fois', () => {
    const { report, next } = applyRun(EMPTY_STATE, [ok('csp-dinum', [job('A'), job('B')], ['X'])], today)
    assert.deepEqual(report.newListings, [])
    assert.deepEqual(report.initialised, [{ label: 'Source csp-dinum', count: 3 }])
    assert.deepEqual(next.sources['csp-dinum']?.seen, { A: today, B: today, X: today })
  })

  it('annonce les seules annonces inconnues et les retient avec la date du jour', () => {
    const state = stateWith('csp-dinum', { A: '2026-10-01' })
    const { report, next } = applyRun(state, [ok('csp-dinum', [job('A'), job('B')])], today)
    assert.deepEqual(report.newListings.map((l) => l.id), ['B'])
    assert.deepEqual(next.sources['csp-dinum']?.seen, { A: '2026-10-01', B: today })
    assert.equal(next.sources['csp-dinum']?.lastSuccessOn, today)
  })

  it('retient les annonces hors périmètre sans jamais les annoncer', () => {
    const state = stateWith('afd', { A: '2026-10-01' })
    const { report, next } = applyRun(state, [ok('afd', [], ['A', 'B'])], today)
    assert.deepEqual(report.newListings, [])
    assert.deepEqual(next.sources['afd']?.seen, { A: '2026-10-01', B: today })
  })

  it('garde intact l\'état d\'une source en échec et la signale', () => {
    const state = stateWith('csp-dinum', { A: '2026-10-01' })
    const failed: SourceOutcome = { sourceId: 'csp-dinum', label: 'Choisir le service public — DINUM', kind: 'job', ok: false, error: 'HTTP 503' }
    const { report, next } = applyRun(state, [failed], today)
    assert.deepEqual(next.sources['csp-dinum'], state.sources['csp-dinum'])
    assert.deepEqual(report.failures, [{ label: 'Choisir le service public — DINUM', error: 'HTTP 503' }])
  })

  it('n\'annonce qu\'une fois un appel d\'offres publié à la fois sur BOAMP et TED', () => {
    const state: VeilleState = {
      ...EMPTY_STATE,
      sources: {
        boamp: { seen: {}, lastCount: 0, lastSuccessOn: '2026-10-21' },
        ted: { seen: {}, lastCount: 0, lastSuccessOn: '2026-10-21' },
      },
      procedures: { 'proc-ancienne': '2026-10-20' },
    }
    const outcomes = [
      ok('boamp', [tender('26-1', 'proc-1'), tender('26-2')], [], 'tender'),
      ok('ted', [tender('700-2026', 'proc-1'), tender('701-2026', 'proc-ancienne'), tender('702-2026', 'proc-2')], [], 'tender'),
    ]
    const { report, next } = applyRun(state, outcomes, today)
    assert.deepEqual(report.newListings.map((l) => l.id), ['26-1', '26-2', '702-2026'])
    assert.deepEqual(Object.keys(next.sources['ted']?.seen ?? {}).sort(), ['700-2026', '701-2026', '702-2026'], 'doublons retenus comme vus')
    assert.equal(next.procedures['proc-1'], today)
    assert.equal(next.procedures['proc-2'], today)
  })

  it('oublie les annonces disparues depuis plus de 120 jours, garde celles toujours en ligne', () => {
    const state = stateWith('csp-dinum', { ancienne: '2026-06-01', 'ancienne-en-ligne': '2026-06-01', recente: '2026-09-01' })
    const { next } = applyRun(state, [ok('csp-dinum', [job('ancienne-en-ligne')])], today)
    assert.deepEqual(Object.keys(next.sources['csp-dinum']?.seen ?? {}).sort(), ['ancienne-en-ligne', 'recente'])
  })

  it('note la présence des annonces toujours en ligne, au plus une fois par mois', () => {
    const state = stateWith('csp-dinum', { A: '2026-08-01', B: '2026-10-10' })
    const { next } = applyRun(state, [ok('csp-dinum', [job('A'), job('B')])], today)
    assert.deepEqual(next.sources['csp-dinum']?.seen, { A: today, B: '2026-10-10' })
  })

  it('ne réannonce pas une offre ancienne absente d\'une seule lecture', () => {
    // Offre en ligne depuis mai, présence notée le 1er octobre, absente le 22 (offre décalée d'une page), revenue le 23.
    const state = stateWith('lbp', { OLD: '2026-10-01', X: '2026-10-01' })
    const absent = applyRun(state, [ok('lbp', [job('X')])], today)
    const back = applyRun(absent.next, [ok('lbp', [job('X'), job('OLD')])], '2026-10-23')
    assert.deepEqual(back.report.newListings, [])
  })

  it('répète l\'alerte tant que la source reste vide, sans rien oublier', () => {
    const state = stateWith('lbp', { A: '2026-05-01' }, 87)
    const day1 = applyRun(state, [ok('lbp', [])], today)
    const day2 = applyRun(day1.next, [ok('lbp', [])], '2026-10-23')
    assert.equal(day1.report.warnings.length, 1)
    assert.equal(day2.report.warnings.length, 1)
    assert.equal(day2.next.sources['lbp']?.lastCount, 87)
    assert.deepEqual(day2.next.sources['lbp']?.seen, { A: '2026-05-01' }, 'rien d\'oublié pendant la panne')
    const repaired = applyRun(day2.next, [ok('lbp', [job('A')])], '2026-10-24')
    assert.deepEqual(repaired.report.newListings, [], 'pas de réannonce au retour de la source')
  })

  it('signale trois semaines sans aucun appel d\'offres', () => {
    const quiet = (lastNonEmptyOn: string) => ({
      ...EMPTY_STATE,
      sources: { boamp: { seen: {}, lastCount: 0, lastSuccessOn: '2026-10-21', lastNonEmptyOn } },
    })
    assert.deepEqual(applyRun(quiet('2026-10-10'), [ok('boamp', [], [], 'tender')], today).report.warnings, [])
    const { report } = applyRun(quiet('2026-09-25'), [ok('boamp', [], [], 'tender')], today)
    assert.match(report.warnings[0]?.message ?? '', /Aucun avis depuis le 25\/09\/2026/)
  })

  it('reprend les avertissements donnés par une source', () => {
    const outcome: SourceOutcome = {
      sourceId: 'boamp',
      label: 'Source boamp',
      kind: 'tender',
      ok: true,
      batch: { listings: [], ignoredIds: [], warnings: ['2 avis illisibles'] },
    }
    const { report } = applyRun(stateWith('boamp', {}), [outcome], today)
    assert.deepEqual(report.warnings, [{ label: 'Source boamp', message: '2 avis illisibles' }])
  })

  it('oublie les procédures annoncées depuis plus de 120 jours', () => {
    const state: VeilleState = { ...EMPTY_STATE, procedures: { vieille: '2026-06-01', recente: '2026-10-01' } }
    const { next } = applyRun(state, [], today)
    assert.deepEqual(Object.keys(next.procedures), ['recente'])
  })

  it('signale une source d\'offres d\'emploi qui se vide ou perd plus de la moitié de ses annonces', () => {
    const vide = applyRun(stateWith('lbp', {}, 87), [ok('lbp', [])], today)
    assert.equal(vide.report.warnings.length, 1)
    assert.match(vide.report.warnings[0]?.message ?? '', /Aucune annonce lue alors qu'il y en avait 87/)

    const chute = applyRun(stateWith('csp-dgfip', {}, 334), [ok('csp-dgfip', Array.from({ length: 20 }, (_, i) => job(`J${i}`)))], today)
    assert.match(chute.report.warnings[0]?.message ?? '', /20 annonces lues contre 334/)

    const normal = applyRun(stateWith('csp-dinum', {}, 11), [ok('csp-dinum', [job('A')])], today)
    assert.deepEqual(normal.report.warnings, [], 'petite source : variations normales')
  })

  it('ne signale pas une semaine sans appel d\'offres', () => {
    const { report } = applyRun(stateWith('boamp', {}, 12), [ok('boamp', [], [], 'tender')], today)
    assert.deepEqual(report.warnings, [])
  })

  it('ne modifie pas l\'état reçu', () => {
    const state = stateWith('csp-dinum', { A: '2026-10-01' })
    const before = structuredClone(state)
    applyRun(state, [ok('csp-dinum', [job('A'), job('B')])], today)
    assert.deepEqual(state, before)
  })
})
