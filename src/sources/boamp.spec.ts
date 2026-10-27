import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { HttpClient } from '../http/http-client.js'
import { OTHER_BUYERS_ID, organisationsFrom } from '../organisations.js'
import { DEFAULT_SETTINGS } from '../settings/defaults.js'
import { scopeToIt } from '../it-scope.js'
import { allBuyersSearchFrom } from '../tenders/all-buyers.js'
import {
  BoampAllBuyersSource,
  boampAllBuyersWheres,
  boampBuyers,
  boampMainCpv,
  boampDescription,
  boampRecordToListing,
  boampWhere,
  extractBoampBuyers,
  type BoampRecord,
} from './boamp.source.js'

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

  it('reprend l\'objet détaillé et les lots d\'un avis, jamais ses contacts', () => {
    const mapa = {
      MAPA: {
        organisme: { correspondantPRM: { nom: 'DUPONT' }, acheteurPublic: 'A.S.P.' },
        initial: {
          description: { objet: 'Rénovation fictive du site régional' },
          caracteristiques: { principales: 'Prix révisable' },
          lots: { lot: [{ description: 'lot 1 : Maçonnerie fictive' }, { description: 'Peinture fictive' }] },
        },
      },
    }
    assert.deepEqual(boampDescription(mapa), {
      description: 'Rénovation fictive du site régional\n\nPrix révisable\n\nLots\n- Lot 1 : Maçonnerie fictive\n- Lot 2 : Peinture fictive',
      location: undefined,
    })
    const eformsWithText = eforms([{ id: 'ORG-0001', name: 'INSEE', siret: '12002701600563' }], ['ORG-0001'])
    const root = eformsWithText.EFORMS.ContractNotice as Record<string, unknown>
    root['cac:ProcurementProject'] = {
      'cbc:Description': { '#text': 'Prestations fictives de maquettage' },
      'cac:RealizedLocation': { 'cbc:Description': { '#text': 'Montrouge' } },
    }
    root['cac:ProcurementProjectLot'] = [{ 'cac:ProcurementProject': { 'cbc:Name': { '#text': 'Lot fictif' } } }]
    assert.deepEqual(boampDescription(eformsWithText), { description: 'Prestations fictives de maquettage\n\nLots\n- Lot 1 : Lot fictif', location: 'Montrouge' })
    // Lieu saisi sur plusieurs paragraphes : une seule ligne courte (ligne « Lieu » de l'e-mail).
    root['cac:ProcurementProject'] = { 'cac:RealizedLocation': { 'cbc:Description': { '#text': `Site fictif\n\nConditions : ${'x '.repeat(200)}` } } }
    const location = boampDescription(eformsWithText).location ?? ''
    assert.ok(location.startsWith('Site fictif Conditions : x x') && !location.includes('\n'))
    assert.equal(location.length, 200)
  })

  it('lit le code CPV principal des avis européens et nationaux, sans les codes secondaires ni ceux des lots', () => {
    const eformsCpv = { EFORMS: { ContractNotice: {
      'cac:ProcurementProject': {
        'cac:MainCommodityClassification': { 'cbc:ItemClassificationCode': { '@listName': 'cpv', '#text': '30232150' } },
        'cac:AdditionalCommodityClassification': [{ 'cbc:ItemClassificationCode': { '#text': '48820000' } }],
      },
      'cac:ProcurementProjectLot': [{ 'cac:ProcurementProject': { 'cac:MainCommodityClassification': { 'cbc:ItemClassificationCode': { '#text': '72000000' } } } }],
    } } }
    assert.equal(boampMainCpv(eformsCpv), '30232150')
    const fns = { FNSimple: { initial: { natureMarche: { codeCPV: { objetPrincipal: { classPrincipale: '72212000' }, objetComplementaire: { classPrincipale: '30200000' } } } } } }
    assert.equal(boampMainCpv(fns), '72212000')
    assert.equal(boampMainCpv({ MAPA: { organisme: { classificationOrganisme: '5' } } }), undefined, 'les petits avis n\'en ont pas')
  })

  it('signale un avis au contenu illisible au lieu de perdre en silence la reconnaissance par SIRET', () => {
    assert.equal(boampBuyers(record({ nomacheteur: 'Direction fictive', donnees: '{"tronqué' })).unreadable, true)
    assert.equal(boampBuyers(record({ nomacheteur: 'Direction fictive', donnees: '{"NOUVEAU_FORMAT":{}}' })).unreadable, true)
    const fns = JSON.stringify({ FNSimple: { organisme: { nomOfficiel: 'Direction fictive', codeIdentificationNational: '12002701600563' } } })
    assert.equal(boampBuyers(record({ donnees: fns })).unreadable, false)
  })

  it('présente l\'avis avec son acheteur, son type, sa procédure et l\'identifiant commun avec TED', () => {
    const donnees = eforms([{ id: 'ORG-0001', name: 'INSEE', siret: '12002701600563' }], ['ORG-0001'])
    const listing = boampRecordToListing(
      record({ nomacheteur: 'INSEE', donnees: JSON.stringify(donnees), contractfolderid: 'proc-fictive', code_departement: ['92'] }),
    )
    assert.deepEqual(listing, {
      kind: 'tender',
      id: '26-000001',
      organisationId: 'insee',
      title: 'Prestations fictives',
      url: 'https://www.boamp.fr/pages/avis/?q=idweb:26-000001',
      publishedOn: '2026-10-20',
      deadline: '2026-11-19T11:00:00+00:00',
      details: ['BOAMP', 'Acheteur : INSEE', 'Services', 'Procédure ouverte', 'Marchés européens'],
      location: 'Département(s) 92',
      description: undefined,
      procedureId: 'proc-fictive',
    })
  })

  it('neutralise une expression hostile des réglages et ne produit jamais de clause vide', () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.organisations = [{ id: 'fictif', name: 'Fictif', enabled: true, tenderRules: [{ sirens: [], names: ['x" OR nature="X'], excludedNames: [], requiredText: [], note: '' }] }]
    const where = boampWhere('2026-06-24', '2026-10-22', organisationsFrom(settings))
    assert.match(where, /nomacheteur like "x or nature x"/)
    assert.equal((where.match(/"/g) ?? []).length % 2, 0, 'guillemets appariés')
    assert.throws(() => boampWhere('2026-06-24', '2026-10-22', []), /Aucun organisme à chercher/)
  })

  it('ne demande que les avis de marché encore ouverts, et les achats SPM seulement s\'ils citent la DINUM', () => {
    const where = boampWhere('2026-06-24', '2026-10-22')
    assert.match(
      where,
      /^dateparution>=date'2026-06-24' AND \(datelimitereponse>=date'2026-10-22' OR datelimitereponse is null\) AND nature="APPEL_OFFRE" AND etat="INITIAL" AND \(/,
    )
    assert.ok(where.includes('search(donnees,"180035016*")'))
    assert.ok(where.includes('nomacheteur like "agence des participations de l etat"'))
    assert.ok(where.includes('((nomacheteur like "services du premier ministre"'))
    assert.ok(where.includes('AND (donnees like "dinum" OR donnees like "direction interministerielle du numerique"))'))
  })
})

describe('BOAMP : recherche chez tous les acheteurs', () => {
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.tenderKeywords = {
    allBuyers: true,
    families: [{ id: 'donnees', label: 'Données', phrases: ['gouvernance des donnees', 'developpement d application*'], acronyms: ['MDM'] }],
    infrastructurePhrases: ['fourniture de serveurs'],
  }
  const search = allBuyersSearchFrom(settings)
  assert.ok(search)
  const donnees = (name: string, mainCpv = '72000000') =>
    JSON.stringify({
      FNSimple: {
        organisme: { nomOfficiel: name },
        initial: { description: { objet: 'Objet détaillé fictif.' }, natureMarche: { codeCPV: { objetPrincipal: { classPrincipale: mainCpv } } } },
      },
    })
  /** Faux BOAMP : avis légers selon la requête, avis complets pour `idweb IN`. */
  const fakeHttp = (answer: (where: string, light: boolean) => BoampRecord[], full: Map<string, BoampRecord>, fullRequests: string[] = []) =>
    ({
      json: async (url: string, schema: { parse(value: unknown): unknown }) => {
        const params = new URL(url).searchParams
        const where = params.get('where') ?? ''
        let results: BoampRecord[]
        if (where.startsWith('idweb IN')) {
          fullRequests.push(where)
          results = [...full.values()].filter((record) => where.includes(`"${record.idweb}"`))
        } else results = answer(where, params.has('select'))
        return schema.parse({ total_count: results.length, results })
      },
    }) as unknown as HttpClient
  const fetchWith = (http: HttpClient, known: string[] = []) =>
    new BoampAllBuyersSource(http, () => new Date('2026-10-22T05:00:00Z'), organisationsFrom(settings), search).fetch({ isKnown: (id) => known.includes(id) })

  it('cherche chaque famille dans l\'objet, sans requête par classification, sans mot d\'une lettre ni clause vide', () => {
    const wheres = boampAllBuyersWheres('2026-06-24', '2026-10-22', search)
    assert.deepEqual(wheres.map((w) => w.label), ['Famille « Données »'])
    assert.ok(wheres.every(({ where }) => where.startsWith(`dateparution>=date'2026-06-24' AND`) && where.includes('etat="INITIAL"')))
    assert.match(wheres[0]?.where ?? '', /\(search\(objet,"gouvernance des donnees"\) OR search\(objet,"developpement application"\) OR search\(objet,"mdm"\)\)$/)
    assert.deepEqual(boampAllBuyersWheres('2026-06-24', '2026-10-22', { ...search, families: [] }), [])
  })

  it('garde les avis exacts d\'autres acheteurs sous leur nom, laisse ceux des organismes suivis à la source BOAMP, et ne relit en entier que les avis inconnus', async () => {
    const light = {
      unknown: record({ idweb: '26-000010', objet: 'Mission de gouvernance des données fictive', nomacheteur: 'Commune fictive' }),
      disordered: record({ idweb: '26-000011', objet: 'Données fictives : gouvernance des voiries', nomacheteur: 'Commune fictive' }),
      known: record({ idweb: '26-000012', objet: 'Gouvernance des données fictive du département', nomacheteur: 'Département fictif' }),
      followed: record({ idweb: '26-000013', objet: 'Gouvernance des données fictive', nomacheteur: 'Direction générale des finances publiques' }),
    }
    const full = new Map([['26-000010', { ...light.unknown, donnees: donnees('Commune fictive') }]])
    const fullRequests: string[] = []
    const batch = await fetchWith(fakeHttp(() => Object.values(light), full, fullRequests), ['26-000012'])

    assert.deepEqual(batch.listings.map((l) => l.id), ['26-000010', '26-000012'], 'avis au désordre et avis de la DGFiP écartés')
    assert.deepEqual(fullRequests, ['idweb IN ("26-000010")'], 'avis déjà connu non relu')
    const other = batch.listings.find((l) => l.id === '26-000010')
    assert.equal(other?.organisationId, OTHER_BUYERS_ID)
    assert.equal(other?.buyer, 'Commune fictive')
    assert.equal(other?.description, 'Objet détaillé fictif.')
    assert.equal(other?.mainCpv, '72000000')
    assert.deepEqual(batch.ignoredIds, [])
  })

  it('juge l\'avis complet sur son code CPV principal', async () => {
    const project = record({ idweb: '26-000020', objet: 'Gouvernance des données fictive', nomacheteur: 'Commune fictive' })
    const consulting = record({ idweb: '26-000021', objet: 'Formation fictive à la gouvernance des données', nomacheteur: 'Commune fictive' })
    const full = new Map([
      ['26-000020', { ...project, donnees: donnees('Commune fictive', '72224000') }],
      ['26-000021', { ...consulting, donnees: donnees('Commune fictive', '80500000') }],
    ])
    const batch = await fetchWith(fakeHttp(() => [project, consulting], full))
    const scoped = scopeToIt(batch, search.rules)
    assert.deepEqual(scoped.batch.listings.map((l) => l.id), ['26-000020'])
    assert.deepEqual(scoped.outOfScope, ['26-000021'], 'classé formation : écarté et retenu comme vu')
  })

  it('nomme la famille de mots-clés qui ramène trop d\'avis', async () => {
    const tooMany = Array.from({ length: 100 }, (_, i) => record({ idweb: `26-1${String(i).padStart(5, '0')}`, objet: 'Avis fictif' }))
    const http = {
      json: async (_url: string, schema: { parse(value: unknown): unknown }) => schema.parse({ total_count: 5000, results: tooMany }),
    } as unknown as HttpClient
    await assert.rejects(fetchWith(http), /^Error: Famille « Données » : Plus de 2000 avis ouverts/)
  })
})
