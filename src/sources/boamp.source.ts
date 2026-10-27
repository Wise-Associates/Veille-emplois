// Appels d'offres publiés au BOAMP, lus dans les données ouvertes de la DILA (API OpenDataSoft, sans clé, Licence
// Ouverte). La requête ramène large (SIREN cherché dans tout l'avis, noms d'acheteurs) ; chaque avis est ensuite
// vérifié sur ses vrais acheteurs (buyer-match.ts), car le SIREN d'un organisme apparaît aussi dans les avis d'autres
// acheteurs (titulaire, comptable, instance de recours).

import { z } from 'zod'
import { addDays, parisDay } from '../dates.js'
import type { HttpClient } from '../http/http-client.js'
import { isItTender } from '../it-scope.js'
import type { Listing, ListingSource, SourceBatch, SourceContext } from '../listing.js'
import { ORGANISATIONS, OTHER_BUYERS_ID, type Organisation } from '../organisations.js'
import type { AllBuyersSearch } from '../tenders/all-buyers.js'
import { matchOrganisation, type Buyer } from '../tenders/buyer-match.js'
import { limitText } from '../text.js'

const API_URL = 'https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/boamp/records'
/**
 * Chaque passage relit tous les avis encore ouverts (date limite de réponse non passée) publiés depuis 120 jours : le
 * premier passage envoie ainsi tous les appels d'offres auxquels on peut encore répondre, et un passage manqué est
 * rattrapé tant que l'avis est ouvert. Les avis déjà envoyés sont reconnus grâce au fichier d'état. 120 jours couvrent
 * largement les délais de réponse (une quarantaine d'avis ouverts en octobre 2026, BOAMP et TED réunis).
 */
export const PUBLICATION_LOOKBACK_DAYS = 120
/** Limite imposée par l'API. */
const PAGE_SIZE = 100
/** Garde-fou : une vingtaine d'avis ouverts pour ces organismes en octobre 2026. */
const MAX_PAGES = 10
/**
 * Garde-fou d'une requête chez tous les acheteurs : en octobre 2026, 199 avis ouverts classés informatique et jusqu'à
 * 251 pour une famille (« BI » : la recherche ignore la casse, l'intitulé est revérifié ensuite).
 */
const MAX_ALL_BUYERS_PAGES = 20
/** Avis complets lus par requête (identifiants dans l'adresse). */
const FULL_RECORDS_CHUNK = 50
/**
 * Champs d'un avis sans son contenu (`donnees`, 14 Ko en moyenne) : la recherche chez tous les acheteurs renvoie
 * plusieurs centaines d'avis à chaque passage, dont seuls les nouveaux sont lus en entier.
 */
const LIGHT_FIELDS = [
  'idweb', 'objet', 'nomacheteur', 'dateparution', 'datelimitereponse', 'type_marche', 'famille_libelle',
  'procedure_libelle', 'contractfolderid', 'url_avis', 'code_departement', 'descripteur_libelle',
].join(',')

const recordSchema = z.object({
  idweb: z.string().min(1),
  objet: z.string().nullish(),
  nomacheteur: z.string().nullish(),
  dateparution: z.string().nullish(),
  datelimitereponse: z.string().nullish(),
  type_marche: z.array(z.string()).nullish(),
  famille_libelle: z.string().nullish(),
  procedure_libelle: z.string().nullish(),
  contractfolderid: z.string().nullish(),
  url_avis: z.string().nullish(),
  code_departement: z.array(z.string()).nullish(),
  descripteur_libelle: z.array(z.string()).nullish(),
  donnees: z.string().nullish(),
})
const pageSchema = z.object({ total_count: z.number().int(), results: z.array(recordSchema) })

export type BoampRecord = z.infer<typeof recordSchema>

const MARKET_TYPES: Record<string, string> = { SERVICES: 'Services', FOURNITURES: 'Fournitures', TRAVAUX: 'Travaux' }

/**
 * Avis de marché initiaux (ni rectificatifs ni résultats) publiés depuis `since` et encore ouverts le jour `today` (un
 * avis sans date limite est gardé : rien ne dit qu'il est clos). Au BOAMP, un rectificatif d'avis européen garde
 * nature = APPEL_OFFRE : seul etat = INITIAL désigne un nouvel avis.
 */
function openNotices(since: string, today: string): string {
  return (
    `dateparution>=date'${since}' AND (datelimitereponse>=date'${today}' OR datelimitereponse is null) ` +
    `AND nature="APPEL_OFFRE" AND etat="INITIAL"`
  )
}

/** Requête OpenDataSoft : avis ouverts des organismes suivis (openNotices). */
export function boampWhere(since: string, today: string, organisations: readonly Organisation[] = ORGANISATIONS): string {
  const ruleClauses = organisations.flatMap((organisation) =>
    organisation.tenderRules.map((rule) => {
      const buyer = [
        ...(rule.sirens ?? []).map((siren) => `search(donnees,"${siren}*")`),
        ...(rule.names ?? []).map((name) => `nomacheteur like "${name}"`),
      ].join(' OR ')
      if (!rule.requiredText) return buyer
      const text = rule.requiredText.map((phrase) => `donnees like "${phrase}"`).join(' OR ')
      return `((${buyer}) AND (${text}))`
    }),
  )
  // Jamais de clause vide, que le BOAMP refuse (« AND () ») ; createSources ne lit pas le BOAMP sans organisme à chercher.
  if (!ruleClauses.length) throw new Error('Aucun organisme à chercher au BOAMP : aucune règle d\'acheteur dans les réglages.')
  return `${openNotices(since, today)} AND (${ruleClauses.join(' OR ')})`
}

/**
 * Mots d'une expression pour la recherche du BOAMP, qui ne trouve pas les mots d'une lettre (« développement d
 * application » ne donne rien) et ramène déjà les pluriels.
 */
function searchWords(phrase: string): string {
  return phrase
    .split(' ')
    .map((word) => word.replace('*', ''))
    .filter((word) => word.length > 1)
    .join(' ')
}

/**
 * Requêtes de la recherche chez tous les acheteurs (all-buyers.ts) : avis ouverts classés informatique par le BOAMP,
 * puis une requête par famille de mots-clés, cherchés dans l'objet ; `label` nomme la requête dans une erreur.
 * Expressions et descripteurs validés par les réglages (ni guillemet ni barre oblique inverse) : sûrs entre guillemets.
 * Jamais de clause vide.
 */
export function boampAllBuyersWheres(since: string, today: string, search: AllBuyersSearch): { label: string; where: string }[] {
  const clauses = [
    { label: 'Avis classés informatique', clause: search.boampDescriptors.map((descriptor) => `descripteur_libelle="${descriptor}"`).join(' OR ') },
    ...search.families.map((family) => ({
      label: `Famille « ${family.label} »`,
      clause: [...new Set([...family.phrases.map(searchWords), ...family.acronyms.map((acronym) => acronym.toLowerCase())])]
        .filter(Boolean)
        .map((words) => `search(objet,"${words}")`)
        .join(' OR '),
    })),
  ]
  return clauses.filter(({ clause }) => clause).map(({ label, clause }) => ({ label, where: `${openNotices(since, today)} AND (${clause})` }))
}

type Json = unknown

function child(value: Json, key: string): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, Json>)[key] : undefined
}

function list(value: Json): Json[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/** Valeur texte d'un champ eForms, écrit soit "valeur", soit { "#text": "valeur", ... }. */
function text(value: Json): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  const nested = child(value, '#text')
  return typeof nested === 'string' ? nested : undefined
}

/**
 * Acheteurs déclarés dans le contenu d'un avis (`donnees`). Seuls les noms et SIRET sont lus : les avis contiennent
 * aussi des contacts nominatifs, jamais repris.
 */
export function extractBoampBuyers(donnees: Json): Buyer[] {
  const eforms = child(donnees, 'EFORMS')
  if (eforms && typeof eforms === 'object') {
    // Avis européens (eForms) : les acheteurs sont les « ContractingParty », décrits dans la liste des organisations
    // de l'avis, qui contient aussi l'instance de recours et parfois les titulaires.
    const root = Object.values(eforms as Record<string, Json>)[0]
    const buyerIds = new Set(
      list(child(root, 'cac:ContractingParty'))
        .map((party) => text(child(child(child(party, 'cac:Party'), 'cac:PartyIdentification'), 'cbc:ID')))
        .filter((id): id is string => id !== undefined),
    )
    const extension = list(child(root, 'ext:UBLExtensions')).flatMap((extensions) => list(child(extensions, 'ext:UBLExtension')))
    const organizations = extension.flatMap((ext) =>
      list(child(child(child(child(ext, 'ext:ExtensionContent'), 'efext:EformsExtension'), 'efac:Organizations'), 'efac:Organization')),
    )
    return organizations.flatMap((organization) => {
      const company = child(organization, 'efac:Company')
      const id = text(child(child(company, 'cac:PartyIdentification'), 'cbc:ID'))
      if (!id || !buyerIds.has(id)) return []
      const name = text(child(child(company, 'cac:PartyName'), 'cbc:Name')) ?? ''
      const siret = list(child(company, 'cac:PartyLegalEntity')).map((entity) => text(child(entity, 'cbc:CompanyID'))).find(Boolean)
      return [{ name, siret }]
    })
  }
  // Avis nationaux (FNSimple, MAPA…) : un bloc « organisme », avec SIRET au-delà de 90 k€, sans en dessous.
  return Object.values((donnees && typeof donnees === 'object' ? donnees : {}) as Record<string, Json>).flatMap((form) => {
    const organisme = child(form, 'organisme')
    if (!organisme) return []
    const name = text(child(organisme, 'nomOfficiel')) ?? text(child(organisme, 'acheteurPublic')) ?? ''
    return [{ name, siret: text(child(organisme, 'codeIdentificationNational')) }]
  })
}

/**
 * Acheteurs d'un avis : le nom d'acheteur du BOAMP et ceux déclarés dans son contenu. `unreadable` : contenu illisible
 * ou sans acheteur reconnaissable (format changé ?) ; l'avis n'est alors reconnu que par son nom d'acheteur, et la
 * source le signale (la reconnaissance par SIRET, la plus sûre, ne fonctionne plus).
 */
export function boampBuyers(record: BoampRecord): { buyers: Buyer[]; unreadable: boolean } {
  const named: Buyer[] = record.nomacheteur ? [{ name: record.nomacheteur }] : []
  if (!record.donnees) return { buyers: named, unreadable: false }
  const donnees = parseDonnees(record)
  if (donnees === null) return { buyers: named, unreadable: true }
  const declared = extractBoampBuyers(donnees)
  return { buyers: [...named, ...declared], unreadable: declared.length === 0 }
}

/** Contenu de l'avis, ou null s'il est illisible (signalé par la source, voir boampBuyers). */
function parseDonnees(record: BoampRecord): Json | null {
  if (!record.donnees) return {}
  try {
    return JSON.parse(record.donnees)
  } catch {
    return null
  }
}

/**
 * Codes CPV d'un avis (procédure et lots) : `cbc:ItemClassificationCode` des avis européens (eForms), `codeCPV` des
 * avis nationaux. Les petits avis (MAPA) n'en ont pas.
 */
export function boampCpvCodes(donnees: Json): string[] {
  const codes = new Set<string>()
  const collect = (value: Json): void => {
    const code = text(value)
    if (code && /^\d{8}/.test(code.trim())) codes.add(code.trim().slice(0, 8))
    else if (value && typeof value === 'object') for (const nested of Object.values(value as Record<string, Json>)) collect(nested)
  }
  const walk = (value: Json): void => {
    if (!value || typeof value !== 'object') return
    for (const [key, nested] of Object.entries(value as Record<string, Json>)) {
      if (key === 'cbc:ItemClassificationCode' || key === 'codeCPV') collect(nested)
      else walk(nested)
    }
  }
  walk(donnees)
  return [...codes]
}

/**
 * Texte de l'avis (objet détaillé, caractéristiques, lots) et lieu d'exécution. Seuls ces champs sont lus : l'avis
 * contient aussi des contacts nominatifs, jamais repris.
 */
export function boampDescription(donnees: Json): { description?: string; location?: string } {
  const eforms = child(donnees, 'EFORMS')
  let summary: (string | undefined)[]
  let lots: { name?: string; description?: string }[]
  let location: string | undefined
  if (eforms && typeof eforms === 'object') {
    const root = Object.values(eforms as Record<string, Json>)[0]
    const project = child(root, 'cac:ProcurementProject')
    summary = [text(child(project, 'cbc:Description'))]
    location = text(child(child(project, 'cac:RealizedLocation'), 'cbc:Description'))
    lots = list(child(root, 'cac:ProcurementProjectLot')).map((lot) => {
      const lotProject = child(lot, 'cac:ProcurementProject')
      return { name: text(child(lotProject, 'cbc:Name')), description: text(child(lotProject, 'cbc:Description')) }
    })
  } else {
    // Avis nationaux : FNSimple (natureMarche), MAPA (description, caractéristiques).
    const initial = child(Object.values((donnees && typeof donnees === 'object' ? donnees : {}) as Record<string, Json>)[0], 'initial')
    summary = [
      text(child(child(initial, 'natureMarche'), 'description')),
      text(child(child(initial, 'description'), 'objet')),
      text(child(child(initial, 'caracteristiques'), 'principales')),
    ]
    lots = list(child(child(initial, 'lots'), 'lot')).map((lot) => ({ name: text(child(lot, 'intitule')), description: text(child(lot, 'description')) }))
  }
  // Les acheteurs écrivent souvent « lot 1 : Désamiantage » : le numéro est déjà donné par la ligne.
  const withoutNumber = (part: string | undefined) => part?.replace(/^lot\s*n?°?\s*\d+\s*[:\-–—]\s*/i, '').trim() || undefined
  const lotLines = lots
    .map((lot, index) => {
      const parts = [withoutNumber(lot.name), withoutNumber(lot.description)].filter(
        (part, i, all): part is string => Boolean(part) && all.indexOf(part) === i,
      )
      return parts.length ? `- Lot ${index + 1} : ${parts.join(' — ')}` : ''
    })
    .filter(Boolean)
  const blocks = [[...new Set(summary.filter(Boolean))].join('\n\n'), lotLines.length ? `Lots\n${lotLines.join('\n')}` : ''].filter(Boolean)
  return { description: blocks.length ? limitText(blocks.join('\n\n')) : undefined, location: shortLocation(location) }
}

/** Au-delà, le lieu d'exécution est coupé. */
const MAX_LOCATION_CHARS = 200

/**
 * Lieu d'exécution saisi librement par l'acheteur, parfois sur plusieurs paragraphes (conditions de participation,
 * durée…) : une seule ligne courte, pour la ligne « Lieu » de l'e-mail et le récapitulatif.
 */
function shortLocation(location: string | undefined): string | undefined {
  const line = location?.replace(/\s+/g, ' ').trim()
  if (!line) return undefined
  return line.length > MAX_LOCATION_CHARS ? `${line.slice(0, MAX_LOCATION_CHARS - 1)}…` : line
}

/**
 * Annonce correspondant à un avis BOAMP, ou null si aucun de ses acheteurs n'est un organisme suivi. `allBuyers` (avis
 * de la recherche chez tous les acheteurs) : un avis d'un autre acheteur est rattaché à « Autres acheteurs », avec son
 * nom d'acheteur. Avis sans contenu (`donnees`, champs légers) : annonce sans description ni CPV.
 */
export function boampRecordToListing(
  record: BoampRecord,
  organisations: readonly Organisation[] = ORGANISATIONS,
  options: { allBuyers?: boolean } = {},
): Listing | null {
  const { buyers } = boampBuyers(record)
  const followed = matchOrganisation({ buyers, text: `${record.objet ?? ''} ${record.donnees ?? ''}` }, organisations)
  const buyer = record.nomacheteur?.replace(/\s+/g, ' ').trim()
  const organisationId = followed ?? (options.allBuyers ? OTHER_BUYERS_ID : null)
  if (!organisationId) return null

  const marketTypes = (record.type_marche ?? []).map((type) => MARKET_TYPES[type] ?? type).join(', ')
  const donnees = parseDonnees(record) ?? {}
  const { description, location } = boampDescription(donnees)
  const cpv = boampCpvCodes(donnees)
  const descriptors = (record.descripteur_libelle ?? []).filter(Boolean)
  const departments = (record.code_departement ?? []).filter(Boolean)
  return {
    kind: 'tender',
    id: record.idweb,
    organisationId,
    ...(followed ? {} : { buyer: buyer || 'Acheteur public' }),
    title: record.objet?.trim() || '(objet non précisé)',
    url: record.url_avis ?? `https://www.boamp.fr/pages/avis/?q=idweb:${encodeURIComponent(record.idweb)}`,
    publishedOn: record.dateparution ?? undefined,
    deadline: record.datelimitereponse ?? undefined,
    details: [
      'BOAMP',
      ...(buyer ? [`Acheteur : ${buyer}`] : []),
      ...(marketTypes ? [marketTypes] : []),
      ...(record.procedure_libelle ? [record.procedure_libelle] : []),
      ...(record.famille_libelle ? [record.famille_libelle] : []),
    ],
    location: location ?? (departments.length ? `Département(s) ${departments.join(', ')}` : undefined),
    description,
    procedureId: record.contractfolderid ?? undefined,
    ...(cpv.length ? { cpv } : {}),
    ...(descriptors.length ? { descriptors } : {}),
  }
}

/** Avis du BOAMP pour une requête, page après page ; `select` : champs légers seulement (LIGHT_FIELDS). */
async function boampRecords(http: HttpClient, where: string, maxPages: number, select?: string): Promise<BoampRecord[]> {
  const records: BoampRecord[] = []
  for (let page = 0; ; page++) {
    if (page >= maxPages) throw new Error(`Plus de ${maxPages * PAGE_SIZE} avis ouverts : requête à vérifier.`)
    const params = new URLSearchParams({ where, order_by: 'dateparution desc', limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) })
    if (select) params.set('select', select)
    const response = await http.json(`${API_URL}?${params}`, pageSchema)
    records.push(...response.results)
    if (records.length >= response.total_count) break
    if (response.results.length === 0) throw new Error(`Page vide après ${records.length} avis sur ${response.total_count} annoncés.`)
  }
  return records
}

/** Avis des organismes suivis, reconnus par leurs règles d'acheteur. */
export class BoampSource implements ListingSource {
  readonly id = 'boamp'
  readonly label = 'BOAMP'
  readonly kind = 'tender'

  /** `organisations` : organismes suivis d'après les réglages du passage (organisationsFrom). */
  constructor(
    private readonly http: HttpClient,
    private readonly now: () => Date,
    private readonly organisations: readonly Organisation[],
  ) {}

  async fetch(): Promise<SourceBatch> {
    const today = parisDay(this.now())
    const where = boampWhere(addDays(today, -PUBLICATION_LOOKBACK_DAYS), today, this.organisations)
    const records = await boampRecords(this.http, where, MAX_PAGES)
    const listings = records.map((record) => boampRecordToListing(record, this.organisations)).filter((l): l is Listing => l !== null)
    const unreadable = records.filter((record) => boampBuyers(record).unreadable).map((record) => record.idweb)
    const warnings = unreadable.length
      ? [`${unreadable.length} avis au contenu illisible (${unreadable.slice(0, 5).join(', ')}) : reconnus par le seul nom d'acheteur, le format a peut-être changé.`]
      : []
    // Les avis d'autres acheteurs ne sont pas retenus comme vus : les avis ouverts sont relus à chaque passage, et
    // une règle d'organisme corrigée doit pouvoir rattraper les avis encore ouverts.
    return { listings, ignoredIds: [], warnings }
  }
}

/**
 * Recherche chez tous les acheteurs (all-buyers.ts) : source à part, avec sa clé dans le fichier d'état. Une famille de
 * mots-clés trop large qui la fait échouer n'arrête pas la lecture des organismes suivis, et l'alerte « aucun avis
 * depuis trois semaines » de ceux-ci n'est pas masquée par les avis des autres acheteurs. Les avis d'un organisme suivi
 * sont laissés à la source BOAMP (pas de doublon).
 */
export class BoampAllBuyersSource implements ListingSource {
  readonly id = 'boamp-tous-acheteurs'
  readonly label = 'BOAMP — tous les acheteurs'
  readonly kind = 'tender'

  constructor(
    private readonly http: HttpClient,
    private readonly now: () => Date,
    private readonly organisations: readonly Organisation[],
    private readonly search: AllBuyersSearch,
  ) {}

  /**
   * Avis lus d'abord sans leur contenu ; ceux qui ne peuvent pas correspondre (la recherche du BOAMP ignore l'ordre des
   * mots) sont laissés de côté, sans être retenus comme vus. Seuls les avis encore inconnus de la veille sont relus en
   * entier (description, CPV, acheteurs) : les autres ont déjà été envoyés ou écartés. Le périmètre complet, infrastructure
   * comprise, est jugé ensuite sur l'avis entier (scopeToIt) : une description peut contenir un mot-clé.
   */
  async fetch(context: SourceContext): Promise<SourceBatch> {
    const today = parisDay(this.now())
    const light = new Map<string, BoampRecord>()
    for (const { label, where } of boampAllBuyersWheres(addDays(today, -PUBLICATION_LOOKBACK_DAYS), today, this.search)) {
      try {
        for (const record of await boampRecords(this.http, where, MAX_ALL_BUYERS_PAGES, LIGHT_FIELDS)) light.set(record.idweb, record)
      } catch (error) {
        throw new Error(`${label} : ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const preselection = { ...this.search.rules, infrastructure: [] }
    const candidates = [...light.values()].filter((record) => {
      const listing = this.otherBuyerListing(record)
      return listing !== null && isItTender(listing, preselection)
    })
    const full = await this.fullRecords(candidates.map((record) => record.idweb).filter((id) => !context.isKnown(id)))
    const listings = candidates
      .map((record) => this.otherBuyerListing(full.get(record.idweb) ?? record))
      .filter((l): l is Listing => l !== null)
    return { listings, ignoredIds: [] }
  }

  /** Annonce d'un avis d'un acheteur non suivi, ou null pour un avis d'organisme suivi (lu par la source BOAMP). */
  private otherBuyerListing(record: BoampRecord): Listing | null {
    const listing = boampRecordToListing(record, this.organisations, { allBuyers: true })
    return listing?.organisationId === OTHER_BUYERS_ID ? listing : null
  }

  /** Avis complets, par lots d'identifiants. Un avis retiré entre-temps manque à la réponse : il garde ses champs légers. */
  private async fullRecords(ids: string[]): Promise<Map<string, BoampRecord>> {
    const found = new Map<string, BoampRecord>()
    // Identifiants du BOAMP (« 26-103925 ») : tout autre caractère n'entre pas dans la requête.
    const safe = ids.filter((id) => /^[\w-]+$/.test(id))
    for (let start = 0; start < safe.length; start += FULL_RECORDS_CHUNK) {
      const chunk = safe.slice(start, start + FULL_RECORDS_CHUNK)
      const where = `idweb IN (${chunk.map((id) => `"${id}"`).join(', ')})`
      for (const record of await boampRecords(this.http, where, 1)) found.set(record.idweb, record)
    }
    return found
  }
}
