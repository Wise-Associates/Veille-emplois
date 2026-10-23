import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Listing } from '../listing.js'
import { renderDigest, type DeliverySummary } from './digest.js'

const day = '2026-10-22'
const empty: DeliverySummary = { sent: [], outdated: 0, outOfScope: 0, pending: 0, perRunLimit: 200, timeBudgetMinutes: 25, deliveryError: null, failures: [], warnings: [] }

const listing = (overrides: Partial<Listing>): Listing => ({
  kind: 'job',
  id: 'X',
  organisationId: 'dinum',
  title: 'Offre fictive',
  url: 'https://exemple.test/offre',
  details: [],
  ...overrides,
})

describe('récapitulatif envoyé à l\'équipe', () => {
  it('résume les offres envoyées dans le sujet, au singulier comme au pluriel', () => {
    const mixed = renderDigest({ ...empty, sent: [listing({ kind: 'tender' }), listing({ id: 'Y' })] }, day)
    assert.equal(mixed.subject, "Veille du 22/10/2026 : 1 appel d'offres, 1 offre d'emploi envoyés")
    const jobs = renderDigest({ ...empty, sent: [listing({}), listing({ id: 'Y' })] }, day)
    assert.equal(jobs.subject, "Veille du 22/10/2026 : 2 offres d'emploi envoyées")
  })

  it('le dit quand il n\'y a rien de nouveau', () => {
    const digest = renderDigest(empty, day)
    assert.equal(digest.subject, 'Veille du 22/10/2026 : aucune nouveauté envoyée')
    assert.match(digest.text, /Aucune nouvelle offre envoyée aujourd'hui/)
  })

  it('annonce les offres en attente et comment accélérer leur envoi', () => {
    const digest = renderDigest({ ...empty, sent: [listing({})], pending: 630 }, day)
    assert.match(digest.subject, /— 630 en attente$/)
    assert.match(digest.text, /630 nouvelles offres attendent d'être envoyées à la boîte AO \(au plus 200 par passage, en 25 minutes au plus\)/)
  })

  it('signale en tête l\'envoi interrompu et les sources à vérifier', () => {
    const summary: DeliverySummary = {
      ...empty,
      deliveryError: 'Adresse d\'expédition refusée par le serveur SMTP',
      failures: [{ label: 'BOAMP', error: 'HTTP 503' }],
      warnings: [{ label: 'La Banque Postale', message: 'Aucune annonce lue alors qu\'il y en avait 87 auparavant.' }],
    }
    const digest = renderDigest(summary, day)
    assert.match(digest.subject, /— 3 points à vérifier$/)
    assert.ok(digest.text.indexOf('Points à vérifier') < digest.text.indexOf('Aucune nouvelle offre'))
    assert.match(digest.text, /Envoi des offres interrompu : Adresse d'expédition refusée/)
    assert.match(digest.text, /BOAMP : HTTP 503/)
  })

  it('présente les appels d\'offres puis les offres d\'emploi, par organisme dans l\'ordre de la liste', () => {
    const sent = [
      listing({ id: '1', organisationId: 'proparco', title: 'Chargé d\'affaires fictif' }),
      listing({ id: '2', organisationId: 'dgfip', title: 'Développeur fictif' }),
      listing({ id: '3', kind: 'tender', organisationId: 'insee', title: 'Maquettage fictif', deadline: '2026-11-19T11:00:00+00:00' }),
    ]
    const { text } = renderDigest({ ...empty, sent }, day)
    const order = ['Appels d\'offres', 'INSEE', 'Maquettage fictif', 'Offres d\'emploi', 'DGFiP', 'Développeur fictif', 'Proparco', 'Chargé d\'affaires fictif']
    const positions = order.map((part) => text.indexOf(part))
    assert.ok(positions.every((p) => p >= 0), `tout est présent : ${positions.join(',')}`)
    assert.deepEqual([...positions].sort((a, b) => a - b), positions)
    assert.match(text, /Date limite : 19\/11\/2026 à 12:00/, 'heure de Paris')
  })

  it('échappe le texte venu des sources et n\'affiche que des liens web', () => {
    const { html } = renderDigest({ ...empty, sent: [listing({ title: '<img src=x onerror=alert(1)> & co', url: 'javascript:alert(1)' })] }, day)
    assert.ok(!html.includes('<img src=x'))
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; co'))
    assert.ok(!html.includes('javascript:'))
  })
})
