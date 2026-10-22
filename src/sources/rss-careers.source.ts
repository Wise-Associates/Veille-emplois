// Offres d'emploi publiées dans un flux RSS officiel par le site carrières de l'organisme : SFIL (WordPress) et
// Expertise France (Gestmax).

import { dayFromRssDate } from '../dates.js'
import type { HttpClient } from '../http/http-client.js'
import type { Listing, ListingSource, SourceBatch } from '../listing.js'
import type { OrganisationId } from '../organisations.js'
import { parseRssItems, type RssItem } from './rss.js'

/** Expertise France préfixe ses titres par le département : « Département Gouvernance - GOUV - Responsable… ». */
const EXPERTISE_FRANCE_TITLE = /^(Département .+? - [A-Z0-9]+) - (.+)$/s

/**
 * `linkHost` : site attendu des liens d'offres. Le récapitulatif présente ces liens comme des offres de l'organisme ;
 * un lien vers un autre site (flux compromis, format changé) interrompt la lecture.
 */
export function parseCareersFeed(xml: string, organisationId: OrganisationId, linkHost: string): Listing[] {
  return parseRssItems(xml).map((item: RssItem) => {
    const id = item.guid ?? item.link
    if (!id) throw new Error(`Offre sans identifiant dans le flux (« ${item.title.slice(0, 80)} ») : le format a peut-être changé.`)
    const host = URL.canParse(item.link) ? new URL(item.link).hostname : null
    if (host !== linkHost) throw new Error(`Lien d'offre inattendu (${host ?? 'absent'}, ${linkHost} attendu) : le flux a peut-être changé.`)
    const department = organisationId === 'expertise-france' ? item.title.match(EXPERTISE_FRANCE_TITLE) : null
    return {
      kind: 'job',
      id,
      organisationId,
      title: department?.[2]?.trim() ?? item.title,
      url: item.link,
      publishedOn: dayFromRssDate(item.pubDate),
      details: department?.[1] ? [department[1]] : [],
    }
  })
}

export class RssCareersSource implements ListingSource {
  readonly kind = 'job'

  constructor(
    private readonly http: HttpClient,
    readonly id: string,
    readonly label: string,
    private readonly organisationId: OrganisationId,
    private readonly feedUrl: string,
  ) {}

  async fetch(): Promise<SourceBatch> {
    const xml = await this.http.text(this.feedUrl)
    return { listings: parseCareersFeed(xml, this.organisationId, new URL(this.feedUrl).hostname), ignoredIds: [] }
  }
}
