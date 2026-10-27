// Appels d'offres publiés au Journal officiel de l'UE (TED), lus par l'API de recherche officielle (sans clé,
// réutilisation libre). Indispensable pour Expertise France et Proparco, qui ne publient plus au BOAMP. Comme pour
// le BOAMP, la requête ramène large et chaque avis est vérifié sur ses acheteurs (buyer-match.ts).

import { z } from 'zod'
import { addDays, parisDay } from '../dates.js'
import type { HttpClient } from '../http/http-client.js'
import { isItTender } from '../it-scope.js'
import type { Listing, ListingSource, SourceBatch } from '../listing.js'
import { ORGANISATIONS, OTHER_BUYERS_ID, type Organisation } from '../organisations.js'
import type { AllBuyersSearch } from '../tenders/all-buyers.js'
import { matchOrganisation } from '../tenders/buyer-match.js'
import { limitText } from '../text.js'
import { PUBLICATION_LOOKBACK_DAYS } from './boamp.source.js'

const API_URL = 'https://api.ted.europa.eu/v3/notices/search'
const PAGE_SIZE = 250
const MAX_PAGES = 4

const FIELDS = [
  'publication-number',
  'title-proc',
  'notice-title',
  'description-proc',
  'buyer-name',
  'buyer-identifier',
  'publication-date',
  'deadline-receipt-tender-date-lot',
  'procedure-type',
  'procedure-identifier',
  'main-classification-proc',
]

/** Champ multilingue : { "fra": "…" } ou { "fra": ["…"] }. */
const multilingual = z.record(z.string(), z.union([z.string(), z.array(z.string())]))
const oneOrMany = z.union([z.string(), z.array(z.string())])

const noticeSchema = z.object({
  'publication-number': z.string().min(1),
  'title-proc': multilingual.optional(),
  'notice-title': multilingual.optional(),
  'description-proc': multilingual.optional(),
  'buyer-name': multilingual.optional(),
  'buyer-identifier': oneOrMany.optional(),
  'publication-date': z.string(),
  'deadline-receipt-tender-date-lot': oneOrMany.optional(),
  'procedure-type': oneOrMany.optional(),
  'procedure-identifier': oneOrMany.optional(),
  /** Code CPV principal de la procédure (les codes secondaires et ceux des lots ne comptent pas, it-scope.ts). */
  'main-classification-proc': oneOrMany.optional(),
})
const responseSchema = z.object({ notices: z.array(noticeSchema), totalNoticeCount: z.number().int() })

export type TedNotice = z.infer<typeof noticeSchema>

const PROCEDURE_TYPES: Record<string, string> = {
  open: 'Procédure ouverte',
  restricted: 'Procédure restreinte',
  'neg-w-call': 'Procédure négociée avec mise en concurrence',
  'comp-dial': 'Dialogue compétitif',
  innovation: "Partenariat d'innovation",
  'comp-tend': 'Procédure concurrentielle avec négociation',
}

function values(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

/** Texte en français si disponible, sinon dans la première langue fournie. */
function french(field: z.infer<typeof multilingual> | undefined): string | undefined {
  if (!field) return undefined
  return values(field['fra'] ?? Object.values(field)[0])[0]
}

const TRAILING_LINK_WORDS = new Set(['de', 'des', 'du', 'la', 'le', 'les', 'et'])

/**
 * Expression de recherche TED pour un nom, ou null s'il n'en reste rien. La recherche TED rate les phrases contenant
 * des mots d'une lettre (« caisse nationale de l assurance maladie » ne trouve rien) : la phrase est coupée avant le
 * premier, puis débarrassée des petits mots finaux. La recherche est ainsi plus large ; chaque avis renvoyé est de
 * toute façon revérifié sur la règle exacte (buyer-match.ts).
 */
export function tedName(phrase: string): string | null {
  const words: string[] = []
  for (const word of phrase.split(' ')) {
    if (word.replace('*', '').length <= 1) break
    words.push(word)
  }
  while (words.length && TRAILING_LINK_WORDS.has((words[words.length - 1] ?? '').replace('*', ''))) words.pop()
  if (!words.length) return null
  return words.length === 1 ? (words[0] ?? null) : `"${words.join(' ').replaceAll('*', '')}"`
}

/**
 * Avis de mise en concurrence (ni résultats ni rectificatifs) d'acheteurs français, publiés depuis `since` et dont un
 * lot au moins est encore ouvert le jour `today`.
 */
function openNotices(since: string, today: string): string {
  const compact = (day: string) => day.replaceAll('-', '')
  return (
    `buyer-country=FRA AND publication-date>=${compact(since)} AND deadline-receipt-tender-date-lot>=${compact(today)} ` +
    `AND form-type=competition AND NOT change-notice-version-identifier=*`
  )
}

/** Requête experte TED : avis ouverts des organismes suivis (openNotices). */
export function tedQuery(since: string, today: string, organisations: readonly Organisation[] = ORGANISATIONS): string {
  const sirens = organisations.flatMap((o) => o.tenderRules.flatMap((rule) => (rule.requiredText ? [] : (rule.sirens ?? []))))
  // Réglages sans SIREN, ou dont toutes les expressions sont coupées : jamais de clause vide, que TED refuse (« IN () »).
  const clauses = sirens.length ? [`buyer-identifier IN (${sirens.map((siren) => `${siren}*`).join(' ')})`] : []
  for (const organisation of organisations) {
    for (const rule of organisation.tenderRules) {
      // Sans doublons : plusieurs variantes d'un nom donnent la même expression une fois coupées.
      const names = [...new Set((rule.names ?? []).map(tedName).filter((name): name is string => name !== null))]
      if (!names.length) continue
      const byName = names.map((name) => `buyer-name~${name}`).join(' OR ')
      const texts = (rule.requiredText ?? []).map(tedName).filter((text): text is string => text !== null)
      // Texte exigé entièrement coupé : recherche par le nom seul, plus large ; matchOrganisation revérifie le texte.
      clauses.push(texts.length ? `((${byName}) AND (${texts.map((text) => `FT~${text}`).join(' OR ')}))` : byName)
    }
  }
  if (!clauses.length) throw new Error('Aucun acheteur cherchable dans TED : SIREN ou noms d\'acheteur des organismes à compléter dans les réglages.')
  return `${openNotices(since, today)} AND (${clauses.join(' OR ')})`
}

/**
 * Un terme seul de moins de trois lettres est ignoré par la recherche TED : la condition devient toujours vraie
 * (`title-proc~IA` renvoie tous les avis français ouverts, 4 718 en octobre 2026). Ces sigles ne sont cherchés qu'au
 * BOAMP ; dans TED, un avis qui n'a qu'eux dans son intitulé n'est trouvé que par son code CPV.
 */
const tedSearchable = (term: string) => term.startsWith('"') || term.replace('*', '').length > 2

/**
 * Mot-clé cherché dans l'intitulé de la procédure. Comme pour les noms (tedName), la recherche TED rate les mots d'une
 * lettre ; couper avant le premier ramènerait des milliers d'avis (« développement d application » → « développement ») :
 * chaque morceau est exigé (« développement » et « application »). null s'il n'en reste rien.
 */
export function tedKeywordClause(phrase: string): string | null {
  const segments: string[][] = [[]]
  for (const word of phrase.split(' ')) {
    if (word.replace('*', '').length <= 1) segments.push([])
    else segments[segments.length - 1]?.push(word)
  }
  const terms = segments
    .map((words) => tedName(words.join(' ')))
    .filter((term): term is string => term !== null && tedSearchable(term))
  if (terms.length <= 1) return terms[0] === undefined ? null : `title-proc~${terms[0]}`
  return `(${terms.map((term) => `title-proc~${term}`).join(' AND ')})`
}

/**
 * Requêtes de la recherche chez tous les acheteurs (all-buyers.ts) : avis ouverts classés informatique (CPV), puis une
 * requête par famille de mots-clés, cherchés dans l'intitulé de la procédure (tedKeywordClause ; sigles tels quels, la
 * recherche TED ignore la casse) ; `label` nomme la requête dans une erreur. Jamais de clause vide. La requête par CPV
 * trouve les avis dont l'intitulé contient un sigle de deux lettres (« IA », « BI »), que TED ne sait pas chercher ;
 * comme les autres, ils ne sont gardés qu'avec un mot-clé dans l'intitulé (isItTender).
 */
export function tedAllBuyersQueries(since: string, today: string, search: AllBuyersSearch): { label: string; query: string }[] {
  const clauses = [
    {
      label: 'Avis classés informatique',
      clause: search.cpvPrefixes.length ? `classification-cpv IN (${search.cpvPrefixes.map((prefix) => `${prefix}*`).join(' ')})` : '',
    },
    ...search.families.map((family) => ({
      label: `Famille « ${family.label} »`,
      clause: [
        ...new Set([
          ...family.phrases.map(tedKeywordClause).filter((clause): clause is string => clause !== null),
          ...family.acronyms.filter(tedSearchable).map((acronym) => `title-proc~${acronym}`),
        ]),
      ].join(' OR '),
    })),
  ]
  return clauses.filter(({ clause }) => clause).map(({ label, clause }) => ({ label, query: `${openNotices(since, today)} AND (${clause})` }))
}

/**
 * Annonce correspondant à un avis TED, ou null si aucun de ses acheteurs n'est un organisme suivi. `allBuyers` (avis
 * de la recherche chez tous les acheteurs) : un avis d'un autre acheteur est rattaché à « Autres acheteurs », avec son
 * nom d'acheteur.
 */
export function tedNoticeToListing(
  notice: TedNotice,
  organisations: readonly Organisation[] = ORGANISATIONS,
  options: { allBuyers?: boolean } = {},
): Listing | null {
  const buyerNames = Object.values(notice['buyer-name'] ?? {}).flatMap(values)
  const buyers = [
    ...buyerNames.map((name) => ({ name })),
    ...values(notice['buyer-identifier']).map((siret) => ({ name: '', siret })),
  ]
  // Tout avis de mise en concurrence a un acheteur : un avis renvoyé sans acheteur signale un changement de format de l'API.
  if (!buyers.length) throw new Error(`Avis TED ${notice['publication-number']} sans acheteur : le format de l'API a peut-être changé.`)
  const title = french(notice['title-proc']) ?? french(notice['notice-title']) ?? '(objet non précisé)'
  const description = french(notice['description-proc']) ?? ''
  const followed = matchOrganisation({ buyers, text: `${title} ${description}` }, organisations)
  const organisationId = followed ?? (options.allBuyers ? OTHER_BUYERS_ID : null)
  if (!organisationId) return null

  const number = notice['publication-number']
  // Plusieurs lots : la date limite la plus proche. Format « 2026-11-09+01:00 » : la date seule est gardée.
  const deadline = values(notice['deadline-receipt-tender-date-lot']).map((d) => d.slice(0, 10)).sort()[0]
  const procedure = values(notice['procedure-type'])[0]
  const buyerName = french(notice['buyer-name'])
  const mainCpv = values(notice['main-classification-proc'])[0]
  return {
    kind: 'tender',
    id: number,
    organisationId,
    ...(followed ? {} : { buyer: buyerName?.replace(/\s+/g, ' ').trim() || 'Acheteur public' }),
    title,
    url: `https://ted.europa.eu/fr/notice/-/detail/${encodeURIComponent(number)}`,
    publishedOn: notice['publication-date'].slice(0, 10),
    deadline,
    details: [
      'TED (Journal officiel de l\'UE)',
      ...(buyerName ? [`Acheteur : ${buyerName}`] : []),
      ...(procedure ? [PROCEDURE_TYPES[procedure] ?? procedure] : []),
    ],
    description: description ? limitText(description) : undefined,
    procedureId: values(notice['procedure-identifier'])[0],
    ...(mainCpv ? { mainCpv } : {}),
  }
}

/** Avis TED pour une requête, page après page. */
async function tedNotices(http: HttpClient, query: string): Promise<TedNotice[]> {
  const notices: TedNotice[] = []
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) throw new Error(`Plus de ${MAX_PAGES * PAGE_SIZE} avis TED ouverts : requête à vérifier.`)
    const response = await http.json(API_URL, responseSchema, {
      json: { query, fields: FIELDS, page, limit: PAGE_SIZE, scope: 'ALL', checkQuerySyntax: false, paginationMode: 'PAGE_NUMBER' },
    })
    notices.push(...response.notices)
    if (notices.length >= response.totalNoticeCount) break
    if (response.notices.length === 0) throw new Error(`Page vide après ${notices.length} avis sur ${response.totalNoticeCount} annoncés.`)
  }
  return notices
}

/** Avis des organismes suivis, reconnus par leurs règles d'acheteur. */
export class TedSource implements ListingSource {
  readonly id = 'ted'
  readonly label = "TED (Journal officiel de l'UE)"
  readonly kind = 'tender'

  /** `organisations` : organismes suivis d'après les réglages du passage (organisationsFrom). */
  constructor(
    private readonly http: HttpClient,
    private readonly now: () => Date,
    private readonly organisations: readonly Organisation[],
  ) {}

  async fetch(): Promise<SourceBatch> {
    const today = parisDay(this.now())
    const notices = await tedNotices(this.http, tedQuery(addDays(today, -PUBLICATION_LOOKBACK_DAYS), today, this.organisations))
    // Les avis d'autres acheteurs ne sont pas retenus comme vus : les avis ouverts sont relus à chaque passage, et
    // une règle d'organisme corrigée doit pouvoir rattraper les avis encore ouverts.
    return { listings: notices.map((notice) => tedNoticeToListing(notice, this.organisations)).filter((l): l is Listing => l !== null), ignoredIds: [] }
  }
}

/**
 * Recherche chez tous les acheteurs (all-buyers.ts) : source à part, avec sa clé dans le fichier d'état (même raison que
 * BoampAllBuyersSource). Les avis d'un organisme suivi sont laissés à la source TED (pas de doublon).
 */
export class TedAllBuyersSource implements ListingSource {
  readonly id = 'ted-tous-acheteurs'
  readonly label = "TED (Journal officiel de l'UE) — tous les acheteurs"
  readonly kind = 'tender'

  constructor(
    private readonly http: HttpClient,
    private readonly now: () => Date,
    private readonly organisations: readonly Organisation[],
    private readonly search: AllBuyersSearch,
  ) {}

  async fetch(): Promise<SourceBatch> {
    const today = parisDay(this.now())
    const listings: Listing[] = []
    const seen = new Set<string>()
    for (const { label, query } of tedAllBuyersQueries(addDays(today, -PUBLICATION_LOOKBACK_DAYS), today, this.search)) {
      let notices: TedNotice[]
      try {
        notices = await tedNotices(this.http, query)
      } catch (error) {
        throw new Error(`${label} : ${error instanceof Error ? error.message : String(error)}`)
      }
      for (const notice of notices) {
        if (seen.has(notice['publication-number'])) continue
        const listing = tedNoticeToListing(notice, this.organisations, { allBuyers: true })
        // La recherche TED ignore l'ordre des mots et coupe les expressions : seuls les avis qui correspondent
        // exactement sont gardés, les autres laissés de côté sans être retenus comme vus. Organisme suivi : source TED.
        if (listing?.organisationId !== OTHER_BUYERS_ID || !isItTender(listing, this.search.rules)) continue
        seen.add(listing.id)
        listings.push(listing)
      }
    }
    return { listings, ignoredIds: [] }
  }
}
