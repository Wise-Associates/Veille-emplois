// Sources lues à chaque passage, d'après les réglages (ADR 0005 ; choix des sites et contraintes d'usage de chacun :
// docs/adr/0001-sources-et-contraintes.md).
//
// L'identifiant (`id`) d'une source est sa clé dans le fichier d'état : le changer la fait repartir de zéro (toutes ses
// annonces en ligne seraient renvoyées). Les réglages le fixent à la création d'une source.

import type { Clock } from '../clock.js'
import type { HttpClient } from '../http/http-client.js'
import type { ListingSource } from '../listing.js'
import type { Organisation } from '../organisations.js'
import { BUILTIN_SOURCE_ORGANISATIONS, type BuiltinSourceId, type VeilleSettings } from '../settings/veille-settings.js'
import { AutoriteConcurrenceSource } from './autorite-concurrence.source.js'
import { BanquePostaleSource } from './banque-postale.source.js'
import { BoampSource } from './boamp.source.js'
import { ChoisirLeServicePublicSource } from './choisir-le-service-public.source.js'
import { CrhSource } from './crh.source.js'
import { ProparcoSource } from './proparco.source.js'
import { RssCareersSource } from './rss-careers.source.js'
import { TedSource } from './ted.source.js'

/** Fabrique des sources d'un passage (remplacée dans les tests). */
export const SOURCE_FACTORY = Symbol('SOURCE_FACTORY')
export type SourceFactory = (settings: VeilleSettings, organisations: readonly Organisation[]) => ListingSource[]

/** Sites lus par un code propre ; leur organisme : BUILTIN_SOURCE_ORGANISATIONS (veille-settings.ts). */
const BUILTIN: Record<BuiltinSourceId, (http: HttpClient) => ListingSource> = {
  'autorite-concurrence-carrieres': (http) => new AutoriteConcurrenceSource(http),
  'banque-postale-carrieres': (http) => new BanquePostaleSource(http),
  'afd-carrieres': (http) => new ProparcoSource(http),
  'crh-site': (http) => new CrhSource(http),
}

/**
 * Sources actives des réglages : une source désactivée, ou dont l'organisme l'est (absent de `organisations`), n'est pas
 * lue (son état reste tel quel). BOAMP avant TED : un appel d'offres publié sur les deux est présenté avec son avis BOAMP.
 */
export function createSources(http: HttpClient, clock: Clock, settings: VeilleSettings, organisations: readonly Organisation[]): ListingSource[] {
  const now = () => clock.now()
  const followed = new Set(organisations.map((o) => o.id))
  // Aucun organisme suivi pour ses appels d'offres (offres d'emploi seulement) : ni BOAMP ni TED à lire.
  const tenders = organisations.some((o) => o.tenderRules.length > 0)
  const rank = { boamp: 0, ted: 1 } as Record<string, number>
  return settings.sources
    .filter((source) => source.enabled)
    .sort((a, b) => (rank[a.kind] ?? 2) - (rank[b.kind] ?? 2))
    .flatMap((source): ListingSource[] => {
      switch (source.kind) {
        case 'boamp':
          return tenders ? [new BoampSource(http, now, organisations)] : []
        case 'ted':
          return tenders ? [new TedSource(http, now, organisations)] : []
        case 'builtin':
          return followed.has(BUILTIN_SOURCE_ORGANISATIONS[source.id]) ? [BUILTIN[source.id](http)] : []
        case 'csp':
          return followed.has(source.organisationId) ? [new ChoisirLeServicePublicSource(http, source.id, source.organisationId, source.label, source.codes)] : []
        case 'rss':
          return followed.has(source.organisationId)
            ? [new RssCareersSource(http, source.id, source.label, source.organisationId, source.url, { readOfferPage: source.readOfferPage })]
            : []
      }
    })
}
