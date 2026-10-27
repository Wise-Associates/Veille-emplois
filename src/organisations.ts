// Organismes suivis et règles qui reconnaissent leurs appels d'offres.
//
// Les avis BOAMP et TED ne disent pas « cet avis est de la DGFiP » : il faut reconnaître l'acheteur. Le SIRET de
// l'acheteur est l'indice le plus sûr, mais il manque sur les petits avis (MAPA) et certains services de l'État
// partagent le SIRET 11000201100044 (« Services de l'État pour la facturation électronique ») : il ne doit jamais
// servir. On combine donc SIREN et nom de l'acheteur. Relevés faits sur 24 mois d'avis (octobre 2026), voir
// docs/adr/0001-sources-et-contraintes.md.
//
// Depuis le 27/10/2026, les organismes et leurs règles sont des réglages (ADR 0005) : modifiés dans l'admin de
// MyBestConsultant, ceux du dépôt dans config/defaults.json (avec la raison de chaque règle particulière, `note`).

import { normalizePhrase } from './phrases.js'
import { DEFAULT_SETTINGS } from './settings/defaults.js'
import type { VeilleSettings } from './settings/veille-settings.js'

/** Identifiant d'un organisme dans les réglages (« dgfip », « insee »…), stable. */
export type OrganisationId = string

/**
 * Une façon de reconnaître l'acheteur d'un avis. Les noms sont des expressions comparées mot à mot, sans accents,
 * majuscules ni ponctuation (« Agence des participations de l'État » s'écrit `agence des participations de l etat`) ;
 * un `*` final accepte la suite du mot (`proparco*` reconnaît « PROPARCO_75 »).
 */
export interface TenderRule {
  /** SIREN (9 chiffres) : un acheteur dont le SIRET commence par l'un d'eux est reconnu, quel que soit son nom. */
  sirens?: string[]
  /** Expressions cherchées dans le nom de l'acheteur. */
  names?: string[]
  /** Expressions qui écartent un acheteur reconnu par son nom (homonymes). */
  excludedNames?: string[]
  /** Le texte de l'avis doit contenir l'une de ces expressions : acheteur qui achète pour plusieurs services. */
  requiredText?: string[]
}

export interface Organisation {
  id: OrganisationId
  name: string
  tenderRules: TenderRule[]
}

/**
 * Appels d'offres des acheteurs non suivis, quand la veille cherche chez tous les acheteurs (ADR 0006). Le tiret bas
 * initial est refusé dans l'identifiant d'un organisme des réglages : pas de collision possible.
 */
export const OTHER_BUYERS_ID: OrganisationId = '_autres-acheteurs'

/**
 * Organismes suivis d'après les réglages, dans leur ordre (un avis reconnu par deux organismes est rattaché au premier :
 * « DGFiP - DRFiP … » à la DGFiP). Un organisme désactivé n'est pas suivi. Expressions mises sous leur forme comparée.
 * Recherche chez tous les acheteurs : « Autres acheteurs » à la fin (envoyés et présentés après les organismes suivis).
 */
export function organisationsFrom(settings: VeilleSettings): Organisation[] {
  // Liste vide = champ absent : `requiredText: []` exigerait une expression parmi aucune (règle jamais vérifiée).
  const optional = (key: keyof TenderRule, values: string[]) => (values.length ? { [key]: values } : {})
  const followed = settings.organisations
    .filter((organisation) => organisation.enabled)
    .map((organisation) => ({
      id: organisation.id,
      name: organisation.name,
      tenderRules: organisation.tenderRules.map((rule) => ({
        ...optional('sirens', rule.sirens),
        ...optional('names', rule.names.map(normalizePhrase)),
        ...optional('excludedNames', rule.excludedNames.map(normalizePhrase)),
        ...optional('requiredText', rule.requiredText.map(normalizePhrase)),
      })),
    }))
  return settings.tenderKeywords.allBuyers ? [...followed, { id: OTHER_BUYERS_ID, name: 'Autres acheteurs', tenderRules: [] }] : followed
}

/** Organismes des réglages du dépôt : valeur par défaut des fonctions qui en ont besoin (et des tests). */
export const ORGANISATIONS: readonly Organisation[] = organisationsFrom(DEFAULT_SETTINGS)

export function organisationName(id: OrganisationId, organisations: readonly Organisation[] = ORGANISATIONS): string {
  const organisation = organisations.find((o) => o.id === id)
  if (!organisation) throw new Error(`Organisme inconnu : ${id}`)
  return organisation.name
}
