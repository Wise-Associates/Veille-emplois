import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isItJob, isItTender, mentionsIt, scopeToIt } from './it-scope.js'
import type { Listing } from './listing.js'

const job = (title: string, details: string[] = []) => isItJob({ title, details })

describe('périmètre informatique : appels d\'offres', () => {
  it('retient les services informatiques et logiciels d\'après la classification CPV', () => {
    assert.equal(isItTender({ title: 'Prestations fictives', cpv: ['72212000'] }), true, 'développement de logiciels')
    assert.equal(isItTender({ title: 'Acquisition fictive', cpv: ['45200000', '48000000'] }), true, 'un code sur plusieurs suffit')
  })

  it('écarte le matériel, les télécommunications et les travaux, même avec un intitulé informatique', () => {
    assert.equal(isItTender({ title: 'Achat de postes informatiques fictifs', cpv: ['30213000'] }), false)
    assert.equal(isItTender({ title: 'Maintenance informatique fictive', cpv: ['50312000'] }), false)
    assert.equal(isItTender({ title: 'Lignes télécom fictives', cpv: ['64200000'] }), false)
  })

  it('retient les descripteurs BOAMP « Informatique (prestations de services) » et « Logiciel »', () => {
    assert.equal(isItTender({ title: 'Marché fictif', descriptors: ['Informatique (prestations de services)'] }), true)
    assert.equal(isItTender({ title: 'Marché fictif', descriptors: ['Logiciel'] }), true)
    assert.equal(isItTender({ title: 'Marché fictif', descriptors: ['Informatique (matériel)'] }), false)
  })

  it('juge sur l\'intitulé un avis sans aucune classification', () => {
    assert.equal(isItTender({ title: 'Assistance à maîtrise d\'ouvrage du système d\'information fictif' }), true)
    assert.equal(isItTender({ title: 'Rénovation fictive du hall d\'accueil' }), false)
    assert.equal(isItTender({ title: 'Travaux fictifs de câblage informatique' }), false, 'travaux hors périmètre')
  })
})

describe('périmètre informatique : offres d\'emploi', () => {
  it('retient les métiers techniques, données, cybersécurité, projets SI et numérique', () => {
    assert.equal(job('Développeur fictif Java H/F'), true)
    assert.equal(job('Ingénieur Kubernetes fictif (H/F)'), true)
    assert.equal(job('Stagiaire science des données fictif'), true)
    assert.equal(job('Architecte cybersécurité fictif'), true)
    assert.equal(job('Business analyst fictif - ERP finance'), true)
    assert.equal(job('Chef de projet MOA fictif'), true)
    assert.equal(job('Web Analyst fictif'), true)
    assert.equal(job('Stage - Webanalyst fictif F/H'), true)
    assert.equal(job('Chargé fictif de transformation digitale'), true)
    assert.equal(job('Expertise fictive de suivi de la digitalisation'), true)
    assert.equal(job('Chef de projet maîtrise d\'ouvrage fictif - opérations de crédits'), true, 'MOA d\'une banque')
    assert.equal(job('Préfigurateur fictif du bureau Applications Transverses de l\'IA'), true)
  })

  it('se fie à la catégorie de la source (domaine « Numérique » de Choisir le service public)', () => {
    assert.equal(job('Préfiguratrice fictive du secrétariat', ['Numérique/Responsable d\'entité dédiée au numérique']), true)
    assert.equal(job('Comptable fictif', ['Finances publiques/Comptable']), false)
  })

  it('écarte les métiers hors informatique, y compris avec un mot ambigu', () => {
    assert.equal(job('Analyste fictif risque de crédit immobilier'), false)
    assert.equal(job('Responsable fictif du réseau d\'agences'), false, '« réseau » seul')
    assert.equal(job('Expert fictif infrastructures aéronautiques'), false, '« infrastructure » seule')
    assert.equal(job('Architecte fictif du patrimoine bâti'), false, '« architecte » seul')
    assert.equal(job('Conseiller bancaire confirmé fictif'), false)
    assert.equal(job('Appui fictif à la maîtrise d\'ouvrage déléguée pour le suivi des travaux de réhabilitation'), false)
    assert.equal(job('Chef de projet MOA fictif - travaux du siège'), false, 'le bâtiment l\'emporte sur les sigles')
  })

  it('ne reconnaît les sigles qu\'en majuscules', () => {
    assert.equal(mentionsIt('Gestionnaire SI fictif'), true)
    assert.equal(mentionsIt('Vous êtes motivé, si possible bilingue'), false)
  })
})

describe('lecture réduite au périmètre informatique', () => {
  it('passe les offres hors informatique dans les offres vues, sans changer le nombre lu', () => {
    const listing = (id: string, title: string): Listing => ({ kind: 'job', id, organisationId: 'dinum', title, url: `https://exemple.test/${id}`, details: [] })
    const { batch, outOfScope } = scopeToIt({ listings: [listing('A', 'Développeur fictif'), listing('B', 'Juriste fictif')], ignoredIds: ['X'] })
    assert.deepEqual(batch.listings.map((l) => l.id), ['A'])
    assert.deepEqual(batch.ignoredIds, ['X', 'B'])
    assert.deepEqual(outOfScope, ['B'])
  })
})
