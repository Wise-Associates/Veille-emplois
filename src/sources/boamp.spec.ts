import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { boampBuyers, boampRecordToListing, boampWhere, extractBoampBuyers, type BoampRecord } from './boamp.source.js'

// Avis fictifs, construits sur la structure réelle des données BOAMP (octobre 2026).
const eforms = (organizations: { id: string; name: string; siret: string }[], buyerIds: string[]) => ({
  EFORMS: {
    ContractNotice: {
      'cac:ContractingParty': buyerIds.map((id) => ({ 'cac:Party': { 'cac:PartyIdentification': { 'cbc:ID': id } } })),
      'ext:UBLExtensions': {
        'ext:UBLExtension': {
          'ext:ExtensionContent': {
            'efext:EformsExtension': {
              'efac:Organizations': {
                'efac:Organization': organizations.map((o) => ({
                  'efac:Company': {
                    'cac:PartyIdentification': { 'cbc:ID': o.id },
                    'cac:PartyName': { 'cbc:Name': { '@languageID': 'FRA', '#text': o.name } },
                    'cac:PartyLegalEntity': { 'cbc:CompanyID': o.siret },
                  },
                })),
              },
            },
          },
        },
      },
    },
  },
})

const record = (overrides: Partial<BoampRecord>): BoampRecord => ({
  idweb: '26-000001',
  objet: 'Prestations fictives',
  nomacheteur: null,
  dateparution: '2026-10-20',
  datelimitereponse: '2026-11-19T11:00:00+00:00',
  type_marche: ['SERVICES'],
  famille_libelle: 'Marchés européens',
  procedure_libelle: 'Procédure ouverte',
  contractfolderid: null,
  url_avis: 'https://www.boamp.fr/pages/avis/?q=idweb:26-000001',
  donnees: null,
  ...overrides,
})

describe('avis du BOAMP', () => {
  it('ne retient comme acheteurs que les « ContractingParty » d\'un avis européen', () => {
    const donnees = eforms(
      [
        { id: 'ORG-0001', name: 'ACOSS ETABLISSEMENT PUBLIC', siret: '18003501600054' },
        { id: 'ORG-0002', name: 'Tribunal administratif fictif', siret: '17750005500013' },
      ],
      ['ORG-0001'],
    )
    assert.deepEqual(extractBoampBuyers(donnees), [{ name: 'ACOSS ETABLISSEMENT PUBLIC', siret: '18003501600054' }])
  })

  it('n\'attribue pas à un organisme l\'avis d\'un autre acheteur qui le cite (titulaire, recours)', () => {
    const donnees = eforms(
      [
        { id: 'ORG-0001', name: 'Communauté de communes fictive', siret: '24540018900065' },
        { id: 'ORG-0002', name: 'Direction générale des finances publiques', siret: '13000495500014' },
      ],
      ['ORG-0001'],
    )
    const listing = boampRecordToListing(record({ nomacheteur: 'Communauté de communes fictive', donnees: JSON.stringify(donnees) }))
    assert.equal(listing, null)
  })

  it('lit le SIRET d\'un avis national et le nom seul d\'un petit avis (MAPA), sans reprendre le contact', () => {
    const fns = { FNSimple: { organisme: { nomOfficiel: 'Direction fictive', codeIdentificationNational: '12002701600563' } } }
    assert.equal(boampRecordToListing(record({ nomacheteur: 'Direction fictive', donnees: JSON.stringify(fns) }))?.organisationId, 'insee')

    const mapa = { MAPA: { organisme: { correspondantPRM: { nom: 'DUPONT', pren: 'CAMILLE' }, acheteurPublic: 'A.S.P.' } } }
    const listing = boampRecordToListing(record({ nomacheteur: 'A.S.P.', donnees: JSON.stringify(mapa) }))
    assert.equal(listing?.organisationId, 'asp')
    assert.ok(!JSON.stringify(listing).includes('DUPONT'), 'aucune donnée personnelle reprise')
  })

  it('signale un avis au contenu illisible au lieu de perdre en silence la reconnaissance par SIRET', () => {
    assert.equal(boampBuyers(record({ nomacheteur: 'Direction fictive', donnees: '{"tronqué' })).unreadable, true)
    assert.equal(boampBuyers(record({ nomacheteur: 'Direction fictive', donnees: '{"NOUVEAU_FORMAT":{}}' })).unreadable, true)
    const fns = JSON.stringify({ FNSimple: { organisme: { nomOfficiel: 'Direction fictive', codeIdentificationNational: '12002701600563' } } })
    assert.equal(boampBuyers(record({ donnees: fns })).unreadable, false)
  })

  it('présente l\'avis avec son acheteur, son type, sa procédure et l\'identifiant commun avec TED', () => {
    const donnees = eforms([{ id: 'ORG-0001', name: 'INSEE', siret: '12002701600563' }], ['ORG-0001'])
    const listing = boampRecordToListing(record({ nomacheteur: 'INSEE', donnees: JSON.stringify(donnees), contractfolderid: 'proc-fictive' }))
    assert.deepEqual(listing, {
      kind: 'tender',
      id: '26-000001',
      organisationId: 'insee',
      title: 'Prestations fictives',
      url: 'https://www.boamp.fr/pages/avis/?q=idweb:26-000001',
      publishedOn: '2026-10-20',
      deadline: '2026-11-19T11:00:00+00:00',
      details: ['BOAMP', 'Acheteur : INSEE', 'Services', 'Procédure ouverte', 'Marchés européens'],
      procedureId: 'proc-fictive',
    })
  })

  it('ne demande que les nouveaux avis de marché, et les achats SPM seulement s\'ils citent la DINUM', () => {
    const where = boampWhere('2026-10-15')
    assert.match(where, /^dateparution>=date'2026-10-15' AND nature="APPEL_OFFRE" AND etat="INITIAL" AND \(/)
    assert.ok(where.includes('search(donnees,"180035016*")'))
    assert.ok(where.includes('nomacheteur like "agence des participations de l etat"'))
    assert.ok(where.includes('((nomacheteur like "services du premier ministre"'))
    assert.ok(where.includes('AND (donnees like "dinum" OR donnees like "direction interministerielle du numerique"))'))
  })
})
