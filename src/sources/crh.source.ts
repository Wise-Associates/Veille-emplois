// La CRH n'a pas de site carrières : sa page d'accueil porte un lien « La CRH recrute » vers une annonce PDF.
// Une annonce est nouvelle quand le lien change de fichier ou que le fichier est remplacé (date Last-Modified).
// Aucun lien de recrutement est un état normal (pas de poste ouvert) : la page est donc d'abord authentifiée comme
// étant bien l'accueil du site, pour qu'une page de maintenance ou de blocage ne passe pas pour « rien de nouveau ».

import * as cheerio from 'cheerio'
import { parisDay } from '../dates.js'
import type { HttpClient } from '../http/http-client.js'
import type { Listing, ListingSource, SourceBatch } from '../listing.js'

const HOME = 'https://www.crh-bonds.com/'
const HOST = new URL(HOME).hostname

/** Liens de recrutement de la page d'accueil, en adresses absolues ; erreur si la page n'est pas l'accueil attendu. */
export function findRecruitmentLinks(html: string): { text: string; url: string }[] {
  const $ = cheerio.load(html)
  if (!/caisse de refinancement de l.habitat|\bCRH\b/i.test(`${$('title').text()} ${$('body').text().slice(0, 5_000)}`)) {
    throw new Error("La page d'accueil de la CRH n'a pas été reconnue (maintenance, blocage ou refonte du site ?).")
  }
  return $('a[href]')
    .toArray()
    .map((link) => ({ text: $(link).text().replace(/\s+/g, ' ').trim(), href: $(link).attr('href') ?? '' }))
    .filter((link) => /recrut/i.test(link.text))
    .map((link) => {
      // new URL encode les accents en UTF-8, comme le serveur l'attend (« Collatéral » → %C3%A9).
      const url = new URL(link.href, HOME)
      if (url.hostname !== HOST) throw new Error(`Lien de recrutement hors du site de la CRH (${url.hostname}) : lecture interrompue.`)
      return { text: link.text, url: url.href }
    })
}

export class CrhSource implements ListingSource {
  readonly id = 'crh-site'
  readonly label = 'CRH — page d\'accueil'
  readonly kind = 'job'

  constructor(private readonly http: HttpClient) {}

  async fetch(): Promise<SourceBatch> {
    // Page en ISO-8859-1, sans en-tête charset fiable.
    const links = findRecruitmentLinks(await this.http.text(HOME, { encoding: 'latin1' }))
    const listings: Listing[] = []
    for (const link of links) {
      const lastModified = (await this.http.head(link.url)).get('last-modified')
      const modified = lastModified ? new Date(lastModified) : null
      const day = modified && !Number.isNaN(modified.getTime()) ? parisDay(modified) : undefined
      listings.push({
        kind: 'job',
        id: `${link.url}#${day ?? 'date-inconnue'}`,
        organisationId: 'crh',
        title: `${link.text} (annonce PDF)`,
        url: link.url,
        publishedOn: day,
        details: [],
      })
    }
    return { listings, ignoredIds: [] }
  }
}
