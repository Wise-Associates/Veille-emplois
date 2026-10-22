import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Listing } from '../listing.js'
import type { RunReport } from '../state/run-state.js'
import { renderDigest } from './digest.js'

const day = '2026-10-22'
const empty: RunReport = { newListings: [], initialised: [], failures: [], warnings: [] }

const listing = (overrides: Partial<Listing>): Listing => ({
  kind: 'job',
  id: 'X',
  organisationId: 'dinum',
  title: 'Offre fictive',
  url: 'https://exemple.test/offre',
  details: [],
  ...overrides,
})

describe('récapitulatif envoyé par e-mail', () => {
  it('résume les nouveautés dans le sujet, au singulier comme au pluriel', () => {
    const one = renderDigest({ ...empty, newListings: [listing({ kind: 'tender' }), listing({ id: 'Y' })] }, day)
    assert.equal(one.subject, "Veille du 22/10/2026 : 1 appel d'offres, 1 offre d'emploi")
    const many = renderDigest({ ...empty, newListings: [listing({}), listing({ id: 'Y' })] }, day)
    assert.equal(many.subject, "Veille du 22/10/2026 : 2 offres d'emploi")
  })

  it('le dit quand il n\'y a rien de nouveau', () => {
    const digest = renderDigest(empty, day)
    assert.equal(digest.subject, 'Veille du 22/10/2026 : aucune nouveauté')
    assert.match(digest.text, /Aucune nouvelle annonce aujourd'hui/)
  })

  it('signale dans le sujet et en tête les sources à vérifier', () => {
    const report: RunReport = {
      ...empty,
      failures: [{ label: 'BOAMP', error: 'HTTP 503' }],
      warnings: [{ label: 'La Banque Postale', message: 'Aucune annonce lue alors qu\'il y en avait 87 au passage précédent.' }],
    }
    const digest = renderDigest(report, day)
    assert.equal(digest.subject, 'Veille du 22/10/2026 : aucune nouveauté — 2 sources à vérifier')
    assert.ok(digest.text.indexOf('Sources à vérifier') < digest.text.indexOf('Aucune nouvelle annonce'))
    assert.match(digest.text, /BOAMP : HTTP 503/)
  })

  it('présente les appels d\'offres puis les offres d\'emploi, par organisme dans l\'ordre de la liste', () => {
    const report: RunReport = {
      ...empty,
      newListings: [
        listing({ id: '1', organisationId: 'proparco', title: 'Chargé d\'affaires fictif' }),
        listing({ id: '2', organisationId: 'dgfip', title: 'Développeur fictif' }),
        listing({ id: '3', kind: 'tender', organisationId: 'insee', title: 'Maquettage fictif', deadline: '2026-11-19T11:00:00+00:00' }),
      ],
    }
    const { text } = renderDigest(report, day)
    const order = ['Appels d\'offres', 'INSEE', 'Maquettage fictif', 'Offres d\'emploi', 'DGFiP', 'Développeur fictif', 'Proparco', 'Chargé d\'affaires fictif']
    const positions = order.map((part) => text.indexOf(part))
    assert.ok(positions.every((p) => p >= 0), `tout est présent : ${positions.join(',')}`)
    assert.deepEqual([...positions].sort((a, b) => a - b), positions)
    assert.match(text, /Date limite : 19\/11\/2026 à 12:00/, 'heure de Paris')
  })

  it('échappe le texte venu des sources et n\'affiche que des liens web', () => {
    const report: RunReport = {
      ...empty,
      newListings: [listing({ title: '<img src=x onerror=alert(1)> & co', url: 'javascript:alert(1)' })],
    }
    const { html } = renderDigest(report, day)
    assert.ok(!html.includes('<img src=x'))
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; co'))
    assert.ok(!html.includes('javascript:'))
  })

  it('indique les sources lues pour la première fois', () => {
    const digest = renderDigest({ ...empty, initialised: [{ label: 'TED', count: 4 }] }, day)
    assert.match(digest.text, /TED \(4 annonces enregistrées\)/)
  })
})
