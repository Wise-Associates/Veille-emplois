// Offres d'emploi publiées dans un flux RSS officiel par le site carrières de l'organisme : SFIL (WordPress, texte
// complet dans le flux) et Expertise France (Gestmax : le flux ne donne que le titre, le texte est sur la page de
// l'offre, dans ses données structurées JobPosting).

import * as cheerio from 'cheerio'
import { dayFromRssDate } from '../dates.js'
import { OFFER_PAGE_REQUEST, type HttpClient } from '../http/http-client.js'
import type { Listing, ListingDetails, ListingSource, SourceBatch } from '../listing.js'
import type { OrganisationId } from '../organisations.js'
import { isPublicHttpsUrl } from '../settings/veille-settings.js'
import { htmlToText } from '../text.js'
import { parseRssItems, type RssItem } from './rss.js'

/** Expertise France préfixe ses titres par le département : « Département Gouvernance - GOUV - Responsable… ». */
const EXPERTISE_FRANCE_TITLE = /^(Département .+? - [A-Z0-9]+) - (.+)$/s

/**
 * `linkHost` : site attendu des liens d'offres. Les e-mails présentent ces liens comme des offres de l'organisme ;
 * un lien vers un autre site (flux compromis, format changé) interrompt la lecture.
 */
export function parseCareersFeed(xml: string, organisationId: OrganisationId, linkHost: string): Listing[] {
  return parseRssItems(xml).map((item: RssItem) => {
    const id = item.guid ?? item.link
    if (!id) throw new Error(`Offre sans identifiant dans le flux (« ${item.title.slice(0, 80)} ») : le format a peut-être changé.`)
    const link = URL.canParse(item.link) ? new URL(item.link) : null
    // https exigé aussi : la page de l'offre peut être lue (readOfferPage), jamais en clair.
    if (link?.hostname !== linkHost || link.protocol !== 'https:') {
      throw new Error(`Lien d'offre inattendu (${link ? `${link.protocol}//${link.hostname}` : 'absent'}, https://${linkHost} attendu) : le flux a peut-être changé.`)
    }
    const department = organisationId === 'expertise-france' ? item.title.match(EXPERTISE_FRANCE_TITLE) : null
    const html = item.content ?? item.description
    return {
      kind: 'job',
      id,
      organisationId,
      title: department?.[2]?.trim() ?? item.title,
      url: item.link,
      publishedOn: dayFromRssDate(item.pubDate),
      details: department?.[1] ? [department[1]] : [],
      description: html ? htmlToText(html) : undefined,
    }
  })
}

/** Compléments lus dans les données structurées JobPosting (schema.org) d'une page d'offre. */
export function parseJobPostingPage(html: string): ListingDetails {
  const $ = cheerio.load(html)
  const posting = $('script[type="application/ld+json"]')
    .toArray()
    .map((script) => {
      try {
        return JSON.parse($(script).text()) as Record<string, unknown>
      } catch {
        // Bloc illisible : les autres blocs de la page sont essayés ; s'il n'y a aucune offre, l'erreur ci-dessous.
        return null
      }
    })
    .find((data) => data?.['@type'] === 'JobPosting')
  if (!posting) throw new Error("Page sans offre d'emploi (offre retirée ou page modifiée).")
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
  const address = ((posting['jobLocation'] as { address?: Record<string, unknown> } | undefined)?.address ?? {}) as Record<string, unknown>
  const location = [text(address['addressLocality']), text(address['addressCountry'])].filter(Boolean).join(', ') || text(address['addressRegion'])
  const description = text(posting['description'])
  return {
    description: description ? htmlToText(description) : undefined,
    deadline: text(posting['validThrough'])?.slice(0, 10),
    publishedOn: text(posting['datePosted'])?.slice(0, 10),
    location,
  }
}

export class RssCareersSource implements ListingSource {
  readonly kind = 'job'
  /** Défini seulement pour les flux sans texte d'offre (Expertise France). */
  readonly describe?: (listing: Listing) => Promise<ListingDetails>

  constructor(
    private readonly http: HttpClient,
    readonly id: string,
    readonly label: string,
    private readonly organisationId: OrganisationId,
    private readonly feedUrl: string,
    options: { readOfferPage: boolean },
  ) {
    if (options.readOfferPage) {
      this.describe = async (listing) => parseJobPostingPage(await this.http.text(listing.url, { ...OFFER_PAGE_REQUEST, allowRedirect: isPublicHttpsUrl }))
    }
  }

  async fetch(): Promise<SourceBatch> {
    // Adresse saisie dans les réglages : ses redirections sont vérifiées (isPublicHttpsUrl).
    const xml = await this.http.text(this.feedUrl, { allowRedirect: isPublicHttpsUrl })
    return { listings: parseCareersFeed(xml, this.organisationId, new URL(this.feedUrl).hostname), ignoredIds: [] }
  }
}
