import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Listing } from '../listing.js'
import { OTHER_BUYERS_ID } from '../organisations.js'
import { renderOfferEmail } from './offer-email.js'

const job: Listing = {
  kind: 'job',
  id: '2026-0000001',
  organisationId: 'dinum',
  title: 'Cheffe de projet fictive H/F',
  url: 'https://choisirleservicepublic.gouv.fr/offre-emploi/2026-0000001/',
  location: '1 rue Fictive 75000 Paris',
  deadline: '2026-11-16',
  details: ['Numérique/Cheffe de projet', 'Emploi ouvert aux contractuels'],
  description: 'Missions :\n- Piloter un projet fictif\n\nProfil :\nBac+5',
}

describe('e-mail d\'une offre (boîte AO)', () => {
  it('présente l\'offre avec les libellés lus par l\'extraction de MyBestConsultant', () => {
    const email = renderOfferEmail(job)
    assert.equal(email.subject, "Offre d'emploi — DINUM — Cheffe de projet fictive H/F")
    assert.match(email.text, /^Intitulé : Cheffe de projet fictive H\/F$/m)
    assert.match(email.text, /^Client : DINUM$/m, 'le client est l\'organisme, pas l\'expéditeur')
    assert.match(email.text, /^Lieu : 1 rue Fictive 75000 Paris$/m)
    assert.match(email.text, /^Date limite de candidature : 16\/11\/2026$/m)
    assert.match(email.text, /^Référence : 2026-0000001$/m)
    assert.match(email.text, /Description\n-+\nMissions :\n- Piloter un projet fictif\n\nProfil :\nBac\+5/)
  })

  it('prend l\'acheteur comme client d\'un avis hors organismes suivis (recherche chez tous les acheteurs)', () => {
    const email = renderOfferEmail({ ...job, kind: 'tender', organisationId: OTHER_BUYERS_ID, buyer: 'Commune fictive' })
    assert.match(email.subject, /^Appel d'offres — Commune fictive — /)
    assert.match(email.text, /^Client : Commune fictive$/m)
  })

  it('nomme la date limite de réponse d\'un appel d\'offres, à l\'heure de Paris', () => {
    const email = renderOfferEmail({ ...job, kind: 'tender', organisationId: 'insee', deadline: '2026-11-19T11:00:00+00:00' })
    assert.match(email.subject, /^Appel d'offres — INSEE — /)
    assert.match(email.text, /^Date limite de réponse : 19\/11\/2026 à 12:00$/m)
    assert.match(email.text, /^Avis officiel : https:\/\//m)
  })

  it('ne donne pas la date de publication, que l\'extraction prendrait pour une date limite', () => {
    assert.doesNotMatch(renderOfferEmail({ ...job, publishedOn: '2026-10-20' }).text, /20\/10\/2026/)
  })

  it('le dit quand la source ne donne pas de description', () => {
    assert.match(renderOfferEmail({ ...job, description: undefined }).text, /Pas de description dans la source/)
  })

  it('échappe le texte venu des sources et refuse les liens non web', () => {
    const email = renderOfferEmail({ ...job, title: '<script>alert(1)</script>', description: '<b>gras</b>', url: 'javascript:alert(1)' })
    assert.ok(!email.html.includes('<script>'))
    assert.ok(email.html.includes('&lt;b&gt;gras&lt;/b&gt;'))
    assert.ok(!email.html.includes('javascript:'))
    assert.match(email.text, /^Offre en ligne : lien indisponible$/m)
  })

  it('limite la longueur du sujet', () => {
    assert.ok(renderOfferEmail({ ...job, title: 'T'.repeat(300) }).subject.length <= 180)
  })
})
