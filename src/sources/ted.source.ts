// Appels d'offres publiés au Journal officiel de l'UE (TED), lus par l'API de recherche officielle (sans clé,
// réutilisation libre). Indispensable pour Expertise France et Proparco, qui ne publient plus au BOAMP. Comme pour
// le BOAMP, la requête ramène large et chaque avis est vérifié sur ses acheteurs (buyer-match.ts).

import { z } from 'zod'
import { addDays, parisDay } from '../dates.js'
import type { HttpClient } from '../http/http-client.js'
import type { Listing, ListingSource, SourceBatch } from '../listing.js'
import { ORGANISATIONS, type Organisation } from '../organisations.js'
import { matchOrganisation } from '../tenders/buyer-match.js'
import { LOOKBACK_DAYS } from './boamp.source.js'

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
  while (words.length && TRAILING_LINK_WORDS.has(words[words.length - 1] ?? '')) words.pop()
  if (!words.length) return null
  return words.length === 1 ? (words[0] ?? null) : `"${words.join(' ').replaceAll('*', '')}"`
}

/** Requête experte TED : avis de mise en concurrence (ni résultats ni rectificatifs) des organismes suivis. */
export function tedQuery(since: string, organisations: readonly Organisation[] = ORGANISATIONS): string {
  const sirens = organisations.flatMap((o) => o.tenderRules.flatMap((rule) => (rule.requiredText ? [] : (rule.sirens ?? []))))
  const clauses = [`buyer-identifier IN (${sirens.map((siren) => `${siren}*`).join(' ')})`]
  for (const organisation of organisations) {
    for (const rule of organisation.tenderRules) {
      // Sans doublons : plusieurs variantes d'un nom donnent la même expression une fois coupées.
      const names = [...new Set((rule.names ?? []).map(tedName).filter((name): name is string => name !== null))]
      if (!names.length) continue
      const byName = names.map((name) => `buyer-name~${name}`).join(' OR ')
      const texts = (rule.requiredText ?? []).map(tedName).filter((text): text is string => text !== null)
      clauses.push(rule.requiredText ? `((${byName}) AND (${texts.map((text) => `FT~${text}`).join(' OR ')}))` : byName)
    }
  }
  const day = since.replaceAll('-', '')
  return (
    `buyer-country=FRA AND publication-date>=${day} AND form-type=competition ` +
    `AND NOT change-notice-version-identifier=* AND (${clauses.join(' OR ')})`
  )
}

/** Annonce correspondant à un avis TED, ou null si aucun de ses acheteurs n'est un organisme suivi. */
export function tedNoticeToListing(notice: TedNotice, organisations: readonly Organisation[] = ORGANISATIONS): Listing | null {
  const buyerNames = Object.values(notice['buyer-name'] ?? {}).flatMap(values)
  const buyers = [
    ...buyerNames.map((name) => ({ name })),
    ...values(notice['buyer-identifier']).map((siret) => ({ name: '', siret })),
  ]
  // La requête filtre sur les acheteurs : un avis renvoyé sans acheteur signale un changement de format de l'API.
  if (!buyers.length) throw new Error(`Avis TED ${notice['publication-number']} sans acheteur : le format de l'API a peut-être changé.`)
  const title = french(notice['title-proc']) ?? french(notice['notice-title']) ?? '(objet non précisé)'
  const description = french(notice['description-proc']) ?? ''
  const organisationId = matchOrganisation({ buyers, text: `${title} ${description}` }, organisations)
  if (!organisationId) return null

  const number = notice['publication-number']
  // Plusieurs lots : la date limite la plus proche. Format « 2026-11-09+01:00 » : la date seule est gardée.
  const deadline = values(notice['deadline-receipt-tender-date-lot']).map((d) => d.slice(0, 10)).sort()[0]
  const procedure = values(notice['procedure-type'])[0]
  const buyerName = french(notice['buyer-name'])
  return {
    kind: 'tender',
    id: number,
    organisationId,
    title,
    url: `https://ted.europa.eu/fr/notice/-/detail/${encodeURIComponent(number)}`,
    publishedOn: notice['publication-date'].slice(0, 10),
    deadline,
    details: [
      'TED (Journal officiel de l\'UE)',
      ...(buyerName ? [`Acheteur : ${buyerName}`] : []),
      ...(procedure ? [PROCEDURE_TYPES[procedure] ?? procedure] : []),
    ],
    procedureId: values(notice['procedure-identifier'])[0],
  }
}

export class TedSource implements ListingSource {
  readonly id = 'ted'
  readonly label = "TED (Journal officiel de l'UE)"
  readonly kind = 'tender'

  constructor(
    private readonly http: HttpClient,
    private readonly now: () => Date,
  ) {}

  async fetch(): Promise<SourceBatch> {
    const query = tedQuery(addDays(parisDay(this.now()), -LOOKBACK_DAYS))
    const notices: TedNotice[] = []
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) throw new Error(`Plus de ${MAX_PAGES * PAGE_SIZE} avis TED sur ${LOOKBACK_DAYS} jours : requête à vérifier.`)
      const response = await this.http.json(API_URL, responseSchema, {
        json: { query, fields: FIELDS, page, limit: PAGE_SIZE, scope: 'ALL', checkQuerySyntax: false, paginationMode: 'PAGE_NUMBER' },
      })
      notices.push(...response.notices)
      if (notices.length >= response.totalNoticeCount) break
      if (response.notices.length === 0) throw new Error(`Page vide après ${notices.length} avis sur ${response.totalNoticeCount} annoncés.`)
    }
    // Les avis d'autres acheteurs ne sont pas retenus comme vus : la fenêtre de 7 jours est relue à chaque passage, et
    // une règle d'organisme corrigée doit pouvoir rattraper les avis de la semaine.
    return { listings: notices.map((notice) => tedNoticeToListing(notice)).filter((l): l is Listing => l !== null), ignoredIds: [] }
  }
}
