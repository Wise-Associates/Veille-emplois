import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tedName, tedNoticeToListing, tedQuery, type TedNotice } from './ted.source.js'

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

  it('reprend les codes CPV de l\'avis, sans doublon', () => {
    assert.deepEqual(tedNoticeToListing(notice({ 'classification-cpv': ['72000000', '72000000', '48000000'] }))?.cpv, ['72000000', '48000000'])
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
