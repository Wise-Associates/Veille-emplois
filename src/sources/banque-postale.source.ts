// Offres de La Banque Postale, lues sur les pages de son site carrières (offres issues de SAP SuccessFactors).
// Il n'existe ni flux ni API publique : la liste est découpée en pages de 4 offres, que le site sert sous forme de
// fragments HTML. robots.txt autorise ces pages.

import { setTimeout as sleep } from 'node:timers/promises'
import * as cheerio from 'cheerio'
import type { HttpClient } from '../http/http-client.js'
import type { Listing, ListingSource, SourceBatch } from '../listing.js'

const SITE = 'https://www.labanquepostale.com'
const PAGE_URL = (page: number) => `${SITE}/candidats/offres-d-emploi/nos-offres-d-emploi/_jcr_content/jobofferlist.p-${page}.html`
/** Garde-fou : 87 offres (22 pages) en octobre 2026. */
const MAX_PAGES = 60
/** Pause entre deux pages, pour ne pas solliciter le site plus qu'un visiteur. */
const PAUSE_MS = 1_000

export interface BanquePostalePage {
  listings: Listing[]
  /** Nombre total de pages annoncé par la page (« Page 1 sur 22 »). */
  pageCount: number
}

export function parseBanquePostalePage(html: string): BanquePostalePage {
  const $ = cheerio.load(html)
  const pageCount = Number(html.match(/Page\s+\d+\s+sur\s+(\d+)/)?.[1])
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('Nombre de pages introuvable : la page a peut-être changé.')

  const listings = $('.o-jobOffer__push')
    .toArray()
    .map((element): Listing => {
      const card = $(element)
      const href = card.find('a[href*=".job-"]').first().attr('href') ?? ''
      const id = href.match(/\.job-(\d+)\.html/)?.[1]
      const title = card.find('h3').first().text().replace(/\s+/g, ' ').trim()
      if (!id || !title) throw new Error('Offre sans identifiant ou sans titre : la page a peut-être changé.')
      const contract = card.find('.a-cat-tag--compte span').not('.sr-only').first().text().trim()
      const [location, entity] = card
        .find('p.o-jobOffer__push__infos > span')
        .toArray()
        .map((span) => $(span).text().replace(/\s+/g, ' ').trim())
      const datetime = card.find('time[datetime]').attr('datetime')
      const url = new URL(href, SITE)
      // Le récapitulatif présente ce lien comme une offre de La Banque Postale : jamais vers un autre site.
      if (url.origin !== SITE) throw new Error(`Lien d'offre hors du site (${url.hostname}) : lecture interrompue.`)
      return {
        kind: 'job',
        id,
        organisationId: 'banque-postale',
        title,
        url: url.href,
        publishedOn: datetime?.match(/^\d{4}-\d{2}-\d{2}/)?.[0],
        location: location || undefined,
        details: [contract, entity].filter((value): value is string => Boolean(value)),
      }
    })
  return { listings, pageCount }
}

export class BanquePostaleSource implements ListingSource {
  readonly id = 'banque-postale-carrieres'
  readonly label = 'La Banque Postale — site carrières'
  readonly kind = 'job'

  constructor(private readonly http: HttpClient) {}

  async fetch(): Promise<SourceBatch> {
    const first = parseBanquePostalePage(await this.http.text(PAGE_URL(1)))
    if (first.pageCount > MAX_PAGES) throw new Error(`${first.pageCount} pages annoncées : lecture à vérifier.`)
    const listings = new Map<string, Listing>()
    for (let page = 1; page <= first.pageCount; page++) {
      let current = first
      if (page > 1) {
        await sleep(PAUSE_MS)
        current = parseBanquePostalePage(await this.http.text(PAGE_URL(page)))
      }
      // Une page annoncée sans aucune offre : cartes renommées ou page bloquée. Seule la dernière peut se vider, si
      // des offres ont été retirées pendant la lecture.
      if (current.listings.length === 0 && page < first.pageCount) {
        throw new Error(`Aucune offre lue sur la page ${page} sur ${first.pageCount} : la page a peut-être changé.`)
      }
      for (const listing of current.listings) listings.set(listing.id, listing)
    }
    return { listings: [...listings.values()], ignoredIds: [] }
  }
}
