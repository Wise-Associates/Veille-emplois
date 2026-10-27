import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { HttpClient } from '../http/http-client.js'
import { OTHER_BUYERS_ID, organisationsFrom } from '../organisations.js'
import { DEFAULT_SETTINGS } from '../settings/defaults.js'
import { allBuyersSearchFrom } from '../tenders/all-buyers.js'
import { tedAllBuyersQueries, tedKeywordClause, tedName, tedNoticeToListing, tedQuery, TedAllBuyersSource, type TedNotice } from './ted.source.js'

// Avis fictif, construit sur la structure réelle des réponses de l'API TED (octobre 2026).
const notice = (overrides: Partial<TedNotice> = {}): TedNotice => ({
  'publication-number': '700001-2026',
  'notice-title': { hun: 'Franciaország – Szolgáltatások – titre traduit', fra: 'France – Services – Prestations fictives' },
  'title-proc': { fra: 'Prestations fictives de conseil' },
  'buyer-name': { fra: ['EXPERTISE FRANCE'] },
  'buyer-identifier': ['80873479200035'],
  'publication-date': '2026-10-19+02:00',
  'deadline-receipt-tender-date-lot': ['2026-11-20+01:00', '2026-11-16+01:00'],
  'procedure-type': 'open',
  'procedure-identifier': 'proc-fictive',
  ...overrides,
})

describe('avis TED', () => {
  it('présente l\'avis en français, avec la date limite la plus proche de ses lots', () => {
    assert.deepEqual(tedNoticeToListing(notice()), {
      kind: 'tender',
      id: '700001-2026',
      organisationId: 'expertise-france',
      title: 'Prestations fictives de conseil',
      url: 'https://ted.europa.eu/fr/notice/-/detail/700001-2026',
      publishedOn: '2026-10-19',
      deadline: '2026-11-16',
      details: ["TED (Journal officiel de l'UE)", 'Acheteur : EXPERTISE FRANCE', 'Procédure ouverte'],
      description: undefined,
      procedureId: 'proc-fictive',
    })
  })

  it('reprend le code CPV principal de la procédure', () => {
    assert.equal(tedNoticeToListing(notice({ 'main-classification-proc': ['72000000'] }))?.mainCpv, '72000000')
  })

  it('écarte un avis dont aucun acheteur n\'est suivi', () => {
    assert.equal(tedNoticeToListing(notice({ 'buyer-name': { fra: ['Commune fictive'] }, 'buyer-identifier': ['21000000000011'] })), null)
  })

  it('reconnaît un SIRET saisi avec des espaces', () => {
    const listing = tedNoticeToListing(notice({ 'buyer-name': { fra: ['Direction fictive'] }, 'buyer-identifier': ['120 027 016 00563'] }))
    assert.equal(listing?.organisationId, 'insee')
  })

  it('refuse un avis sans acheteur plutôt que de le croire hors périmètre', () => {
    assert.throws(() => tedNoticeToListing(notice({ 'buyer-name': undefined, 'buyer-identifier': undefined })), /sans acheteur/)
  })

  it('coupe les noms avant le premier mot d\'une lettre, que la recherche TED ne sait pas traiter', () => {
    assert.equal(tedName('agence des participations de l etat'), '"agence des participations"')
    assert.equal(tedName('caisse nationale de l assurance maladie'), '"caisse nationale"')
    assert.equal(tedName('proparco*'), 'proparco*')
    assert.equal(tedName('institut national de la statistique*'), '"institut national de la statistique"')
    assert.equal(tedName('a s p'), null)
  })

  it('ne produit jamais de clause vide, que TED refuse', () => {
    const byNameOnly = tedQuery('2026-06-24', '2026-10-22', [{ id: 'fictif', name: 'Fictif', tenderRules: [{ names: ['agence fictive du numerique'] }] }])
    assert.ok(!byNameOnly.includes('buyer-identifier IN ()'), 'aucun SIREN : pas de clause SIREN')
    assert.match(byNameOnly, /\(buyer-name~"agence fictive du numerique"\)$/)
    // Texte exigé coupé entièrement (« e-commerce » s'arrête au mot d'une lettre) : recherche par le nom seul.
    const cut = tedQuery('2026-06-24', '2026-10-22', [{ id: 'fictif', name: 'Fictif', tenderRules: [{ sirens: ['123456789'], names: ['agence fictive'], requiredText: ['e commerce'] }] }])
    assert.ok(!cut.includes('AND ()'))
    assert.throws(() => tedQuery('2026-06-24', '2026-10-22', [{ id: 'fictif', name: 'Fictif', tenderRules: [{ names: ['a s p'] }] }]), /Aucun acheteur cherchable/)
  })

  it('ne demande que les mises en concurrence françaises encore ouvertes, sans rectificatifs', () => {
    const query = tedQuery('2026-06-24', '2026-10-22')
    assert.match(
      query,
      /^buyer-country=FRA AND publication-date>=20260624 AND deadline-receipt-tender-date-lot>=20261022 AND form-type=competition AND NOT change-notice-version-identifier=\* AND \(/,
    )
    assert.ok(query.includes('180035016*'))
    assert.ok(query.includes('buyer-name~proparco*'))
    assert.ok(query.includes('buyer-name~"autorite de la concurrence"'))
    assert.ok(query.includes('buyer-name~"agence des participations"'), 'APE publie sous le SIRET partagé : son nom doit être cherché')
    assert.ok(!query.includes('"a s p"'), 'mots trop courts pour la recherche TED')
  })
})

describe('TED : recherche chez tous les acheteurs', () => {
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.tenderKeywords = {
    allBuyers: true,
    families: [{ id: 'donnees', label: 'Données', phrases: ['gouvernance des donnees', 'developpement d application*'], acronyms: ['MDM'] }],
    infrastructurePhrases: [],
  }
  const search = allBuyersSearchFrom(settings)
  assert.ok(search)

  it('cherche les avis classés informatique (CPV), puis chaque famille dans l\'intitulé de la procédure', () => {
    const queries = tedAllBuyersQueries('2026-06-24', '2026-10-22', search)
    assert.deepEqual(queries.map((q) => q.label), ['Avis classés informatique', 'Famille « Données »'])
    assert.match(queries[0]?.query ?? '', /^buyer-country=FRA AND .* AND \(classification-cpv IN \(72\* 48\*\)\)$/)
    assert.match(
      queries[1]?.query ?? '',
      /\(title-proc~"gouvernance des donnees" OR \(title-proc~developpement AND title-proc~application\*\) OR title-proc~MDM\)$/,
      'mots d\'une lettre : chaque morceau exigé',
    )
    assert.deepEqual(tedAllBuyersQueries('2026-06-24', '2026-10-22', { ...search, families: [], cpvPrefixes: [] }), [])
  })

  it('exige chaque morceau d\'un mot-clé coupé aux mots d\'une lettre, sans petit mot final', () => {
    assert.equal(tedKeywordClause('outil* d audit'), '(title-proc~outil* AND title-proc~audit)')
    assert.equal(tedKeywordClause('refonte de* l application'), '(title-proc~refonte AND title-proc~application)')
    assert.equal(tedKeywordClause('tierce maintenance applicative'), 'title-proc~"tierce maintenance applicative"')
    assert.equal(tedKeywordClause('a b'), null)
  })

  it('ne cherche pas dans TED un terme seul de deux lettres, qu\'il ignore (tous les avis seraient renvoyés)', () => {
    const queries = tedAllBuyersQueries('2026-06-24', '2026-10-22', {
      ...search,
      families: [{ id: 'ia', label: 'IA', phrases: ['ia', 'ia generative'], acronyms: ['IA', 'LLM'] }],
    })
    assert.match(queries[1]?.query ?? '', /\(title-proc~"ia generative" OR title-proc~LLM\)$/)
  })

  it('garde les avis d\'autres acheteurs à mot-clé exact et code CPV principal informatique, sous leur nom, sans doublon ni avis d\'organisme suivi', async () => {
    const other = { 'buyer-name': { fra: ['COMMUNE FICTIVE'] }, 'buyer-identifier': ['21000000000000'] }
    const titled = (number: string, title: string, mainCpv: string, fields: Partial<TedNotice> = other) =>
      notice({ ...fields, 'publication-number': number, 'title-proc': { fra: title }, 'main-classification-proc': [mainCpv] })
    const byCpv = titled('700010-2026', 'Plateforme fictive de gouvernance des données', '72212000')
    const exact = titled('700011-2026', 'Solution MDM fictive', '48000000')
    const disordered = titled('700012-2026', 'Développement fictif du territoire', '72000000')
    const classifiedOnly = titled('700013-2026', 'Assistance fictive de gestion documentaire', '72312000')
    const keywordOnly = titled('700014-2026', 'Stand fictif sur la gouvernance des données', '79950000')
    const followed = titled('700015-2026', 'Gouvernance des données fictive', '72212000', {})
    const http = {
      json: async (_url: string, schema: { parse(value: unknown): unknown }, options: { json: { query: string } }) => {
        const { query } = options.json
        const notices = query.includes('classification-cpv') ? [byCpv, exact, classifiedOnly, followed] : [exact, disordered, keywordOnly]
        return schema.parse({ notices, totalNoticeCount: notices.length })
      },
    } as unknown as HttpClient
    const batch = await new TedAllBuyersSource(http, () => new Date('2026-10-22T05:00:00Z'), organisationsFrom(settings), search).fetch()
    assert.deepEqual(batch.listings.map((l) => l.id), ['700010-2026', '700011-2026'], 'un seul indice : écarté ; Expertise France laissée à la source TED')
    assert.ok(batch.listings.every((l) => l.organisationId === OTHER_BUYERS_ID && l.buyer === 'COMMUNE FICTIVE'))
    assert.deepEqual(batch.ignoredIds, [])
  })
})
