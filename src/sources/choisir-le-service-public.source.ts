// Offres d'emploi des services de l'État sur Choisir le service public, lues dans le flux RSS que le site propose
// lui-même (bouton « Flux RSS », servi par son back-office Talentsoft ; textes sous licence Etalab 2.0).
//
// Le flux n'a ni identifiant, ni employeur, ni date de publication fiable (pubDate = dernière mise à jour) : la
// référence de l'offre, en tête du titre, sert d'identifiant. Un code d'organisme couvre aussi ses services
// rattachés (la DGFiP et son réseau, la Cour des comptes et les chambres régionales).

import type { HttpClient } from '../http/http-client.js'
import type { Listing, ListingSource, SourceBatch } from '../listing.js'
import type { OrganisationId } from '../organisations.js'
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
    }
  })
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
}
