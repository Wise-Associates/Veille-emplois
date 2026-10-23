// Offres de Proparco, publiées sur le site carrières du groupe AFD (Cornerstone OnDemand), mêlées à celles de l'AFD.
//
// La page publique contient un jeton anonyme (valable environ une heure) qui ouvre l'API JSON de recherche, celle
// qu'utilise la page elle-même. Rien n'indique l'entité dans la liste : une offre est de Proparco si son titre le dit
// ou, sinon, si son lieu principal (dans le détail de l'offre) est un site Proparco. Le détail n'est demandé que pour
// les offres jamais vues, en respectant le délai de 10 s entre requêtes demandé par robots.txt.

import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { dayFromFrenchDate } from '../dates.js'
import type { HttpClient } from '../http/http-client.js'
import type { Listing, ListingSource, SourceBatch, SourceContext } from '../listing.js'
import { htmlToText } from '../text.js'

const CAREER_SITE = 'https://afd.csod.com/ux/ats/careersite/5/home?c=afd'
const DETAIL_URL = (id: string) => `https://afd.csod.com/services/x/job-requisition/v2/requisitions/${encodeURIComponent(id)}/jobDetails?cultureId=13`
const OFFER_URL = (id: string) => `https://afd.csod.com/ux/ats/careersite/5/home/requisition/${encodeURIComponent(id)}?c=afd`
const CRAWL_DELAY_MS = 10_000
const PAGE_SIZE = 100
const MAX_PAGES = 5
/**
 * Détails demandés au plus par passage (10 s chacun) : après une longue interruption, le reste est examiné aux
 * passages suivants plutôt que de dépasser la durée maximale du workflow.
 */
const MAX_DETAILS_PER_RUN = 15

const contextSchema = z.object({
  token: z.string().min(20),
  endpoints: z.object({ cloud: z.url() }),
})

const requisitionSchema = z.object({
  requisitionId: z.union([z.number(), z.string()]).transform(String),
  displayJobTitle: z.string(),
  postingEffectiveDate: z.string().nullish(),
  postingExpirationDate: z.string().nullish(),
  locations: z.array(z.object({ city: z.string().nullish(), country: z.string().nullish() })).nullish(),
  externalDescription: z.string().nullish(),
})
const searchSchema = z.object({ data: z.object({ totalCount: z.number().int(), requisitions: z.array(requisitionSchema) }) })
// Lieu exigé : un détail sans lieu ferait classer l'offre « hors Proparco » pour toujours (elle serait retenue comme vue).
const detailSchema = z.object({ data: z.object({ primaryLocation: z.object({ title: z.string().min(1) }) }) })

export type Requisition = z.infer<typeof requisitionSchema>

/** Contexte `csod.context = {…};` de la page carrières : jeton anonyme et adresse de l'API. */
export function extractCareerSiteContext(html: string): { token: string; apiBase: string } {
  const start = html.indexOf('csod.context=')
  const end = html.indexOf('</script>', start)
  if (start < 0 || end < 0) throw new Error('Contexte de la page carrières introuvable : la page a peut-être changé.')
  const raw = html.slice(start + 'csod.context='.length, end).trim().replace(/;$/, '')
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Contexte de la page carrières illisible (${(error as Error).message}) : la page a peut-être changé.`)
  }
  const parsed = contextSchema.safeParse(json)
  if (!parsed.success) throw new Error('Jeton de la page carrières introuvable : la page a peut-être changé.')
  const apiBase = new URL(parsed.data.endpoints.cloud)
  // Le jeton n'est envoyé qu'à l'API Cornerstone, jamais à une adresse inattendue.
  if (apiBase.protocol !== 'https:' || !apiBase.hostname.endsWith('.csod.com')) {
    throw new Error(`Adresse d'API inattendue (${apiBase.hostname}) : lecture interrompue.`)
  }
  return { token: parsed.data.token, apiBase: apiBase.href }
}

export function isProparcoTitle(title: string): boolean {
  return /proparco/i.test(title)
}

export function isProparcoLocation(locationTitle: string): boolean {
  return /^proparco\b/i.test(locationTitle.trim())
}

export function requisitionToListing(requisition: Requisition): Listing {
  const location = (requisition.locations ?? [])
    .map((l) => [l.city, l.country].filter(Boolean).join(', '))
    .filter(Boolean)
    .join(' ; ')
  return {
    kind: 'job',
    id: requisition.requisitionId,
    organisationId: 'proparco',
    title: requisition.displayJobTitle.replace(/\s+/g, ' ').trim(),
    url: OFFER_URL(requisition.requisitionId),
    publishedOn: dayFromFrenchDate(requisition.postingEffectiveDate ?? undefined),
    deadline: dayFromFrenchDate(requisition.postingExpirationDate ?? undefined),
    location: location || undefined,
    details: [],
    description: requisition.externalDescription ? htmlToText(requisition.externalDescription) : undefined,
  }
}

export class ProparcoSource implements ListingSource {
  readonly id = 'afd-carrieres'
  readonly label = 'Proparco — site carrières du groupe AFD'
  readonly kind = 'job'

  constructor(private readonly http: HttpClient) {}

  async fetch(context: SourceContext): Promise<SourceBatch> {
    const { token, apiBase } = extractCareerSiteContext(await this.http.text(CAREER_SITE))
    const headers = { Authorization: `Bearer ${token}` }

    const requisitions: Requisition[] = []
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) throw new Error(`Plus de ${MAX_PAGES * PAGE_SIZE} offres : lecture à vérifier.`)
      const body = {
        careerSiteId: 5,
        careerSitePageId: 5,
        pageNumber: page,
        pageSize: PAGE_SIZE,
        cultureId: 13,
        cultureName: 'fr-FR',
        searchText: '',
        states: [],
        countryCodes: [],
        cities: [],
        placeID: '',
        radius: null,
        postingsWithinDays: null,
        customFieldCheckboxKeys: [],
        customFieldDropdowns: [],
        customFieldRadios: [],
      }
      const response = await this.http.json(new URL('rec-job-search/external/jobs', apiBase).href, searchSchema, { headers, json: body })
      requisitions.push(...response.data.requisitions)
      if (requisitions.length >= response.data.totalCount) break
      if (response.data.requisitions.length === 0) {
        throw new Error(`Page vide après ${requisitions.length} offres sur ${response.data.totalCount} annoncées.`)
      }
    }

    const listings: Listing[] = []
    const ignoredIds: string[] = []
    let detailRequests = 0
    for (const requisition of requisitions) {
      if (isProparcoTitle(requisition.displayJobTitle)) {
        listings.push(requisitionToListing(requisition))
        continue
      }
      // Déjà vue (envoyée si elle était de Proparco, écartée sinon) : inutile de redemander le détail.
      if (context.isKnown(requisition.requisitionId)) {
        ignoredIds.push(requisition.requisitionId)
        continue
      }
      // Au-delà du plafond, l'offre n'est ni annoncée ni retenue : elle reste inconnue et sera examinée au passage suivant.
      if (detailRequests >= MAX_DETAILS_PER_RUN) continue
      detailRequests++
      // Délai aussi avant la première demande : la page carrières vient d'être lue sur le même site.
      await sleep(CRAWL_DELAY_MS)
      const detail = await this.http.json(DETAIL_URL(requisition.requisitionId), detailSchema, { headers })
      if (isProparcoLocation(detail.data.primaryLocation.title)) listings.push(requisitionToListing(requisition))
      else ignoredIds.push(requisition.requisitionId)
    }
    const postponed = requisitions.length - listings.length - ignoredIds.length
    const warnings = postponed ? [`${postponed} offres AFD à examiner reportées au passage suivant (plafond de ${MAX_DETAILS_PER_RUN} par passage).`] : []
    return { listings, ignoredIds, warnings }
  }
}
