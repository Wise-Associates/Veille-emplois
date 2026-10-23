// Liste des sources lues à chaque passage, dans l'ordre de lecture. Choix des sources et contraintes d'usage de
// chaque site : docs/adr/0001-sources-et-contraintes.md.
//
// L'identifiant (`id`) d'une source est sa clé dans le fichier d'état : le changer la fait repartir de zéro (ses
// annonces en ligne seront réenregistrées sans être annoncées).

import type { Clock } from '../clock.js'
import type { HttpClient } from '../http/http-client.js'
import type { ListingSource } from '../listing.js'
import { AutoriteConcurrenceSource } from './autorite-concurrence.source.js'
import { BanquePostaleSource } from './banque-postale.source.js'
import { BoampSource } from './boamp.source.js'
import { ChoisirLeServicePublicSource } from './choisir-le-service-public.source.js'
import { CrhSource } from './crh.source.js'
import { ProparcoSource } from './proparco.source.js'
import { RssCareersSource } from './rss-careers.source.js'
import { TedSource } from './ted.source.js'

export const LISTING_SOURCES = Symbol('LISTING_SOURCES')

export function createSources(http: HttpClient, clock: Clock): ListingSource[] {
  const now = () => clock.now()
  const csp = (organisationId: ConstructorParameters<typeof ChoisirLeServicePublicSource>[1], name: string, codes: string[]) =>
    new ChoisirLeServicePublicSource(http, organisationId, `Choisir le service public — ${name}`, codes)

  return [
    // BOAMP avant TED : un appel d'offres publié sur les deux est présenté avec son avis BOAMP.
    new BoampSource(http, now),
    new TedSource(http, now),
    // Codes d'organisme de Choisir le service public, relevés en octobre 2026.
    csp('dgfip', 'DGFiP', ['974']),
    csp('dinum', 'DINUM', ['10668']),
    csp('insee', 'INSEE', ['978']),
    csp('asp', 'ASP', ['1422']),
    csp('ape', 'APE', ['1012']),
    csp('cour-des-comptes', 'Cour des comptes et chambres régionales', ['23']),
    // 24 : autorité indépendante ; 13385 : offres reprises du site des ministères économiques et financiers.
    csp('autorite-concurrence', 'Autorité de la concurrence', ['24', '13385']),
    new AutoriteConcurrenceSource(http),
    new BanquePostaleSource(http),
    new RssCareersSource(http, 'sfil-carrieres', 'SFIL — site carrières', 'sfil', 'https://sfil.fr/offres-emploi/feed/', { readOfferPage: false }),
    new CrhSource(http),
    new ProparcoSource(http),
    // limit=200 : maximum accepté par le flux (20 sinon).
    new RssCareersSource(
      http,
      'expertise-france-carrieres',
      'Expertise France — site carrières',
      'expertise-france',
      'https://expertise-france.gestmax.fr/feed/rss/lang/fr_FR?limit=200',
      { readOfferPage: true },
    ),
  ]
}
