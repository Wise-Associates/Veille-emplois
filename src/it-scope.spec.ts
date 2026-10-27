import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_IT_RULES, itRulesFrom, isItJob, isItTender, mentionsIt, scopeToIt } from './it-scope.js'
import { DEFAULT_SETTINGS } from './settings/defaults.js'
import type { Listing } from './listing.js'
import { OTHER_BUYERS_ID } from './organisations.js'

const job = (title: string, details: string[] = []) => isItJob({ title, details })

type TenderFields = Partial<Pick<Listing, 'mainCpv' | 'descriptors'>>
const followed = (title: string, fields: TenderFields = {}, rules = DEFAULT_IT_RULES) => isItTender({ organisationId: 'insee', title, ...fields }, rules)
const otherBuyer = (title: string, fields: TenderFields = {}, rules = DEFAULT_IT_RULES) =>
  isItTender({ organisationId: OTHER_BUYERS_ID, title, ...fields }, rules)

describe('périmètre informatique : appels d\'offres, deux indices concordants', () => {
  it('retient un avis au code CPV principal informatique dont l\'intitulé contient un mot-clé', () => {
    assert.equal(otherBuyer('Tierce maintenance applicative fictive', { mainCpv: '72267100' }), true)
    assert.equal(otherBuyer('Acquisition fictive d\'un progiciel comptable', { mainCpv: '48440000' }), true)
    assert.equal(followed('Tierce maintenance applicative fictive', { mainCpv: '72267100' }), true)
  })

  it('pour un organisme suivi, accepte aussi le vocabulaire du filtre informatique dans l\'intitulé', () => {
    assert.equal(followed('Prestations informatiques fictives', { mainCpv: '72500000' }), true)
    assert.equal(otherBuyer('Prestations informatiques fictives', { mainCpv: '72500000' }), false, 'autre acheteur : mot-clé exigé')
  })

  it('ne lit que le code CPV principal : un code secondaire « logiciel » ne suffit pas', () => {
    // Relevés le 27/10/2026 : imprimantes (code secondaire 48820000), vidéosurveillance (48000000).
    assert.equal(followed('Renouvellement fictif des imprimantes et de leur logiciel', { mainCpv: '30232150' }), false)
    assert.equal(otherBuyer('Vidéodétection fictive par intelligence artificielle', { mainCpv: '32323500' }), false)
  })

  it('écarte un avis classé informatique dont l\'intitulé ne dit rien d\'informatique', () => {
    // Relevé le 27/10/2026 : gestion documentaire classée « introduction de données » (CPV 72312000).
    assert.equal(otherBuyer('Prestations fictives d\'assistance de gestion documentaire', { mainCpv: '72312000' }), false)
    assert.equal(followed('Prestations fictives d\'assistance de gestion documentaire', { mainCpv: '72312000' }), false)
    assert.equal(followed('Marché fictif', { descriptors: ['Informatique (prestations de services)'] }), false)
  })

  it('écarte un avis classé hors informatique, même avec un mot-clé dans l\'intitulé', () => {
    assert.equal(otherBuyer('Conception fictive d\'un stand sur l\'intelligence artificielle', { mainCpv: '79950000' }), false)
    assert.equal(otherBuyer('Formation fictive aux outils d\'intelligence artificielle', { mainCpv: '80511000' }), false)
    assert.equal(followed('Agence de voyages fictive avec dématérialisation des factures', { mainCpv: '63510000' }), false)
    assert.equal(followed('Maintenance corrective fictive des matériels de cuisine', { mainCpv: '50883000' }), false)
  })

  it('sans code CPV, se fie aux descripteurs du BOAMP', () => {
    assert.equal(otherBuyer('Logiciel fictif de gestion des salles', { descriptors: ['Logiciel'] }), true)
    assert.equal(followed('Logiciel fictif de gestion des salles', { descriptors: ['Informatique (matériel)'] }), false)
    assert.equal(followed('Logiciel fictif', { mainCpv: '30200000', descriptors: ['Logiciel'] }), false, 'le code principal l\'emporte')
  })

  it('sans aucune classification, ne garde que l\'avis d\'un organisme suivi dont l\'intitulé parle d\'informatique', () => {
    assert.equal(followed('Assistance à maîtrise d\'ouvrage du système d\'information fictif'), true)
    assert.equal(followed('Rénovation fictive du hall d\'accueil'), false)
    assert.equal(otherBuyer('Tierce maintenance applicative fictive'), false, 'un seul indice')
  })

  it('ne lit pas la description', () => {
    const listing: Listing = {
      kind: 'tender', id: 'T', organisationId: OTHER_BUYERS_ID, title: 'Fourniture fictive de portiers de rue', url: 'https://exemple.test/T',
      details: [], description: 'Maintenance évolutive du logiciel de supervision.', mainCpv: '72000000',
    }
    assert.equal(isItTender(listing), false)
  })

  it('écarte un intitulé contenant une exclusion (travaux)', () => {
    assert.equal(otherBuyer('Travaux fictifs avec logiciel de supervision', { mainCpv: '48000000' }), false)
    assert.equal(followed('Travaux fictifs de câblage informatique'), false)
  })

  it('ne reconnaît les sigles des mots-clés qu\'en majuscules', () => {
    assert.equal(otherBuyer('Prestations fictives de TMA', { mainCpv: '72000000' }), true)
    assert.equal(otherBuyer('Prestations fictives de tma', { mainCpv: '72000000' }), false)
  })

  it('écarte un avis classé informatique dont l\'intitulé ne parle que d\'infrastructure, sauf avec un mot-clé', () => {
    assert.equal(followed('Fourniture de serveurs informatiques fictifs', { mainCpv: '72500000' }), false)
    assert.equal(followed('Fourniture de serveurs fictifs et d\'un logiciel de sauvegarde', { mainCpv: '72500000' }), true)
  })

  it('sans mot-clé dans les réglages, ne garde aucun avis d\'un autre acheteur', () => {
    const rules = itRulesFrom({ ...DEFAULT_SETTINGS, tenderKeywords: { allBuyers: false, families: [], infrastructurePhrases: [] } })
    assert.equal(otherBuyer('Tierce maintenance applicative fictive', { mainCpv: '72267100' }, rules), false)
    assert.equal(followed('Prestations informatiques fictives', { mainCpv: '72500000' }, rules), true)
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

  it('garde toutes les offres quand le filtre est désactivé dans les réglages', () => {
    const listing: Listing = { kind: 'job', id: 'B', organisationId: 'dinum', title: 'Juriste fictif', url: 'https://exemple.test/B', details: [] }
    const { batch, outOfScope } = scopeToIt({ listings: [listing], ignoredIds: [] }, { ...DEFAULT_IT_RULES, enabled: false })
    assert.deepEqual(batch.listings.map((l) => l.id), ['B'])
    assert.deepEqual(outOfScope, [])
  })

  it('compare une expression saisie avec accents et majuscules comme celles du dépôt', () => {
    const rules = itRulesFrom({
      ...DEFAULT_SETTINGS,
      itScope: { ...DEFAULT_SETTINGS.itScope, phrases: ['Ingénieur Données*'], acronyms: ['PAIE'], exclusionPhrases: [] },
    })
    assert.equal(mentionsIt('INGENIEUR DONNEES FICTIF (H/F)', rules), true, 'accents et majuscules ignorés')
    assert.equal(mentionsIt('Développeur fictif', rules), false, 'les expressions du dépôt sont remplacées')
    assert.equal(mentionsIt('Chef de projet PAIE fictif', rules), true)
  })
})
