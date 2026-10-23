// Appels d'offres publiés au BOAMP, lus dans les données ouvertes de la DILA (API OpenDataSoft, sans clé, Licence
// Ouverte). La requête ramène large (SIREN cherché dans tout l'avis, noms d'acheteurs) ; chaque avis est ensuite
// vérifié sur ses vrais acheteurs (buyer-match.ts), car le SIREN d'un organisme apparaît aussi dans les avis d'autres
// acheteurs (titulaire, comptable, instance de recours).

import { z } from 'zod'
import { addDays, parisDay } from '../dates.js'
import type { HttpClient } from '../http/http-client.js'
import type { Listing, ListingSource, SourceBatch } from '../listing.js'
import { ORGANISATIONS, type Organisation } from '../organisations.js'
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
  donnees: z.string().nullish(),
})
const pageSchema = z.object({ total_count: z.number().int(), results: z.array(recordSchema) })

export type BoampRecord = z.infer<typeof recordSchema>

const MARKET_TYPES: Record<string, string> = { SERVICES: 'Services', FOURNITURES: 'Fournitures', TRAVAUX: 'Travaux' }

/**
 * Requête OpenDataSoft : avis de marché initiaux (ni rectificatifs ni résultats) des organismes suivis, publiés depuis
 * `since` et encore ouverts le jour `today` (un avis sans date limite est gardé : rien ne dit qu'il est clos).
 */
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
  // Au BOAMP, un rectificatif d'avis européen garde nature = APPEL_OFFRE : seul etat = INITIAL désigne un nouvel avis.
  return (
    `dateparution>=date'${since}' AND (datelimitereponse>=date'${today}' OR datelimitereponse is null) ` +
    `AND nature="APPEL_OFFRE" AND etat="INITIAL" AND (${ruleClauses.join(' OR ')})`
  )
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
  return { description: blocks.length ? limitText(blocks.join('\n\n')) : undefined, location }
}

/** Annonce correspondant à un avis BOAMP, ou null si aucun de ses acheteurs n'est un organisme suivi. */
export function boampRecordToListing(record: BoampRecord, organisations: readonly Organisation[] = ORGANISATIONS): Listing | null {
  const { buyers } = boampBuyers(record)
  const organisationId = matchOrganisation({ buyers, text: `${record.objet ?? ''} ${record.donnees ?? ''}` }, organisations)
  if (!organisationId) return null

  const marketTypes = (record.type_marche ?? []).map((type) => MARKET_TYPES[type] ?? type).join(', ')
  const { description, location } = boampDescription(parseDonnees(record) ?? {})
  const departments = (record.code_departement ?? []).filter(Boolean)
  return {
    kind: 'tender',
    id: record.idweb,
    organisationId,
    title: record.objet?.trim() || '(objet non précisé)',
    url: record.url_avis ?? `https://www.boamp.fr/pages/avis/?q=idweb:${encodeURIComponent(record.idweb)}`,
    publishedOn: record.dateparution ?? undefined,
    deadline: record.datelimitereponse ?? undefined,
    details: [
      'BOAMP',
      ...(record.nomacheteur ? [`Acheteur : ${record.nomacheteur.replace(/\s+/g, ' ').trim()}`] : []),
      ...(marketTypes ? [marketTypes] : []),
      ...(record.procedure_libelle ? [record.procedure_libelle] : []),
      ...(record.famille_libelle ? [record.famille_libelle] : []),
    ],
    location: location ?? (departments.length ? `Département(s) ${departments.join(', ')}` : undefined),
    description,
    procedureId: record.contractfolderid ?? undefined,
  }
}

export class BoampSource implements ListingSource {
  readonly id = 'boamp'
  readonly label = 'BOAMP'
  readonly kind = 'tender'

  constructor(
    private readonly http: HttpClient,
    private readonly now: () => Date,
  ) {}

  async fetch(): Promise<SourceBatch> {
    const today = parisDay(this.now())
    const where = boampWhere(addDays(today, -PUBLICATION_LOOKBACK_DAYS), today)
    const records: BoampRecord[] = []
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) throw new Error(`Plus de ${MAX_PAGES * PAGE_SIZE} avis ouverts : requête à vérifier.`)
      const params = new URLSearchParams({ where, order_by: 'dateparution desc', limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) })
      const response = await this.http.json(`${API_URL}?${params}`, pageSchema)
      records.push(...response.results)
      if (records.length >= response.total_count) break
      if (response.results.length === 0) throw new Error(`Page vide après ${records.length} avis sur ${response.total_count} annoncés.`)
    }
    const listings = records.map((record) => boampRecordToListing(record)).filter((l): l is Listing => l !== null)
    const unreadable = records.filter((record) => boampBuyers(record).unreadable).map((record) => record.idweb)
    const warnings = unreadable.length
      ? [`${unreadable.length} avis au contenu illisible (${unreadable.slice(0, 5).join(', ')}) : reconnus par le seul nom d'acheteur, le format a peut-être changé.`]
      : []
    // Les avis d'autres acheteurs ne sont pas retenus comme vus : les avis ouverts sont relus à chaque passage, et
    // une règle d'organisme corrigée doit pouvoir rattraper les avis encore ouverts.
    return { listings, ignoredIds: [], warnings }
  }
}
