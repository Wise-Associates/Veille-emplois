// Offres d'emploi des services de l'État sur Choisir le service public, lues dans le flux RSS que le site propose
// lui-même (bouton « Flux RSS », servi par son back-office Talentsoft ; textes sous licence Etalab 2.0).
//
// Le flux n'a ni identifiant, ni employeur, ni date de publication fiable (pubDate = dernière mise à jour) : la
// référence de l'offre, en tête du titre, sert d'identifiant. Un code d'organisme couvre aussi ses services
// rattachés (la DGFiP et son réseau, la Cour des comptes et les chambres régionales). Employeur exact, date de
// publication et date limite de candidature sont lus sur la page de l'offre, au moment de l'envoyer.

import * as cheerio from 'cheerio'
import { dayFromFrenchDate } from '../dates.js'
import { OFFER_PAGE_REQUEST, type HttpClient } from '../http/http-client.js'
import type { Listing, ListingDetails, ListingSource, SourceBatch } from '../listing.js'
import type { OrganisationId } from '../organisations.js'
import { htmlToText } from '../text.js'
import { parseRssItems } from './rss.js'

const FEED_URL = 'https://place-ep-recrute.talent-soft.com/handlers/offerRss.ashx'
const OFFER_URL = 'https://choisirleservicepublic.gouv.fr/offre-emploi/'

/**
 * Référence en tête du titre : « 2026-2442607 - Directeur technique H/F », « MEF_2026-33005 - … ». Un chiffre est
 * exigé : sans référence, « Stage - Juriste » donnerait l'identifiant « Stage », partagé par d'autres offres.
 */
const TITLE = /^(\S*\d\S*) - (.+)$/s
const LINK_REFERENCE = /\/offre-emploi\/([^/?#]+)\/?/

export function parseCspFeed(xml: string, organisationId: OrganisationId): Listing[] {
  return parseRssItems(xml).map((item) => {
    const titleMatch = item.title.match(TITLE)
    const reference = titleMatch?.[1] ?? item.link.match(LINK_REFERENCE)?.[1]
    if (!reference) throw new Error(`Offre sans référence dans le flux (« ${item.title.slice(0, 80)} ») : le format a peut-être changé.`)
    // Catégories du flux, dans cet ordre : domaine / métier, nature de l'emploi, adresse.
    const [domain, nature, address] = item.categories
    return {
      kind: 'job',
      id: reference,
      organisationId,
      title: (titleMatch?.[2] ?? item.title).trim(),
      url: `${OFFER_URL}${encodeURIComponent(reference)}/`,
      location: address,
      details: [domain, nature].filter((value): value is string => Boolean(value)),
      description: item.description ? htmlToText(item.description) : undefined,
    }
  })
}

/**
 * Compléments lus sur la page d'une offre : données structurées JobPosting (employeur, date de publication) et date
 * limite de candidature, écrite dans le texte. Erreur si la page n'est pas une offre (offre retirée, page modifiée).
 */
export function parseCspOfferPage(html: string, listing: Listing): ListingDetails {
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
  const organisation = posting['hiringOrganization']
  const employer =
    typeof organisation === 'string' ? organisation : typeof organisation === 'object' && organisation ? String((organisation as { name?: unknown }).name ?? '') : ''
  const deadline = $('body').text().match(/Date limite de candidature\s*:\s*(\d{2}\/\d{2}\/\d{4})/)?.[1]
  return {
    publishedOn: dayFromFrenchDate(typeof posting['datePosted'] === 'string' ? posting['datePosted'] : undefined),
    deadline: dayFromFrenchDate(deadline),
    details: employer.trim() ? [`Employeur : ${employer.trim()}`, ...listing.details] : listing.details,
  }
}

export class ChoisirLeServicePublicSource implements ListingSource {
  readonly id: string
  readonly kind = 'job'

  /** `codes` : codes d'organisme de Choisir le service public (ceux de l'URL `…/nos-offres/filtres/organisme/<code>/`). */
  constructor(
    private readonly http: HttpClient,
    private readonly organisationId: OrganisationId,
    readonly label: string,
    private readonly codes: string[],
  ) {
    this.id = `csp-${organisationId}`
  }

  async fetch(): Promise<SourceBatch> {
    const listings = new Map<string, Listing>()
    for (const code of this.codes) {
      // top=1000 : paramètre non documenté du flux ; sans lui, seules les 20 dernières offres sont données (la DGFiP en
      // publie plus de 30 en 48 h). Si le site cessait de l'accepter, la chute du nombre d'offres serait signalée.
      const params = new URLSearchParams({ LCID: '1036', Rss_Entity: code, top: '1000' })
      const xml = await this.http.text(`${FEED_URL}?${params}`)
      for (const listing of parseCspFeed(xml, this.organisationId)) listings.set(listing.id, listing)
    }
    return { listings: [...listings.values()], ignoredIds: [] }
  }

  async describe(listing: Listing): Promise<ListingDetails> {
    return parseCspOfferPage(await this.http.text(listing.url, OFFER_PAGE_REQUEST), listing)
  }
}
