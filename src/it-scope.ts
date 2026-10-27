// Périmètre de la veille : seuls les projets informatiques sont envoyés à la boîte AO (décision du 23/10/2026).
// Règles pures, testées dans it-scope.spec.ts, à vérifier sur les offres réelles avant de les élargir ou les resserrer.
//
// Appels d'offres (ADR 0007, décision du 27/10/2026 : aucun avis hors sujet) : deux indices doivent concorder.
// - Le code CPV principal de l'avis est informatique (72 : services informatiques ; 48 : logiciels et systèmes
//   d'information) ; à défaut de code (petits avis du BOAMP), un descripteur informatique du BOAMP. Les codes
//   secondaires ne comptent pas : un achat d'imprimantes ou de réactifs en porte souvent un « logiciel ».
// - L'intitulé contient un mot-clé des appels d'offres (SaaS, TMA, données, IA…) ; pour un organisme suivi, le
//   vocabulaire du filtre informatique compte aussi. La description ne compte pas : ses mots (« maintenance
//   corrective », « logiciel ») décrivent aussi bien une cuisine ou des portiers que des applications.
// Un avis classé hors informatique est écarté, même avec un mot-clé (stand, formation, agence de voyages relevés le
// 27/10/2026) ; un avis classé informatique sans indice dans son intitulé aussi (saisie de données, accès à Internet,
// licences). Sans aucune classification, seul l'intitulé d'un avis d'organisme suivi décide. Un avis classé informatique
// dont l'intitulé ne parle que d'infrastructure, sans mot-clé des appels d'offres, est écarté.
//
// Offres d'emploi : métiers techniques, données / IA / cybersécurité, projets informatiques et SI métier (AMOA,
// business analyst, ERP, SI financiers), métiers du numérique (UX/UI, web), d'après l'intitulé et la catégorie.

// Les valeurs (préfixes CPV, descripteurs, expressions, sigles, exclusions) sont des réglages (ADR 0005), modifiés dans
// l'admin de MyBestConsultant ; ceux du dépôt sont dans config/defaults.json. Jamais de mot seul ambigu dans les
// expressions : « réseau » (réseau d'agences), « architecte » (bâtiment), « infrastructure » (travaux), « application »
// (d'une règle), « hébergement » (logement), « urbaniste » (urbanisme) n'y sont qu'en expression.

import type { Listing, SourceBatch } from './listing.js'
import { OTHER_BUYERS_ID } from './organisations.js'
import { containsPhrase, normalize, normalizePhrase } from './phrases.js'
import { DEFAULT_SETTINGS } from './settings/defaults.js'
import type { VeilleSettings } from './settings/veille-settings.js'

/** Règles du périmètre informatique, sous la forme comparée (itRulesFrom). */
export interface ItRules {
  /** false : toutes les offres des organismes suivis sont gardées. */
  enabled: boolean
  /** Préfixes CPV (72 : services informatiques ; 48 : logiciels et systèmes d'information). */
  cpvPrefixes: string[]
  /** Descripteurs du BOAMP (thésaurus de la DILA), normalisés. */
  descriptors: Set<string>
  /** Expressions, comparées mot à mot sans accents ni majuscules (`*` final : début de mot). */
  phrases: string[]
  /**
   * Sigles reconnus seulement écrits en majuscules (« SI », pas « si ») : en minuscules, plusieurs sont des mots
   * courants. Un intitulé entièrement en capitales peut en contenir par hasard, le risque est accepté. null : aucun.
   */
  acronyms: RegExp | null
  /**
   * Vocabulaire qui l'emporte sur les expressions et sigles. Bâtiment : la maîtrise d'ouvrage (MOA) y désigne le
   * donneur d'ordre des travaux (« Appui à la maîtrise d'ouvrage déléguée pour le suivi des travaux de réhabilitation »,
   * relevé chez Expertise France), et les travaux sont hors périmètre même informatiques (câblage).
   */
  exclusions: string[]
  /** Mots-clés des appels d'offres, toutes familles réunies (expressions, puis sigles en majuscules). */
  tenderPhrases: string[]
  tenderAcronyms: RegExp | null
  /** « Infrastructure seule », cherchées dans l'intitulé d'un avis classé informatique. */
  infrastructure: string[]
}

// Sigles validés (majuscules et chiffres seulement) : sûrs dans une expression régulière.
const acronymPattern = (acronyms: string[]) => (acronyms.length ? new RegExp(`\\b(${acronyms.join('|')})\\b`) : null)

export function itRulesFrom(settings: Pick<VeilleSettings, 'itScope' | 'tenderKeywords'>): ItRules {
  const { itScope: scope, tenderKeywords: keywords } = settings
  return {
    enabled: scope.enabled,
    cpvPrefixes: scope.cpvPrefixes,
    descriptors: new Set(scope.boampDescriptors.map(normalize)),
    phrases: scope.phrases.map(normalizePhrase),
    acronyms: acronymPattern(scope.acronyms),
    exclusions: scope.exclusionPhrases.map(normalizePhrase),
    tenderPhrases: keywords.families.flatMap((family) => family.phrases.map(normalizePhrase)),
    tenderAcronyms: acronymPattern([...new Set(keywords.families.flatMap((family) => family.acronyms))]),
    infrastructure: keywords.infrastructurePhrases.map(normalizePhrase),
  }
}

/** Règles des réglages du dépôt : valeur par défaut des fonctions ci-dessous (et des tests). */
export const DEFAULT_IT_RULES: ItRules = itRulesFrom(DEFAULT_SETTINGS)

/** Le texte parle-t-il d'informatique (expressions, sigles en majuscules) hors des exclusions ? */
export function mentionsIt(text: string, rules: ItRules = DEFAULT_IT_RULES): boolean {
  const normalized = normalize(text)
  if (rules.exclusions.some((phrase) => containsPhrase(normalized, phrase))) return false
  if (rules.acronyms?.test(text)) return true
  return rules.phrases.some((phrase) => containsPhrase(normalized, phrase))
}

/** Un mot-clé des appels d'offres (expression, ou sigle en majuscules) figure-t-il dans ce texte (un intitulé) ? */
export function mentionsTenderKeyword(text: string, rules: ItRules = DEFAULT_IT_RULES): boolean {
  if (rules.tenderAcronyms?.test(text)) return true
  const normalized = normalize(text)
  return rules.tenderPhrases.some((phrase) => containsPhrase(normalized, phrase))
}

/** Classification d'un avis : son code CPV principal, ou à défaut ses descripteurs du BOAMP. */
function classification(listing: Pick<Listing, 'mainCpv' | 'descriptors'>, rules: ItRules): 'it' | 'other' | 'none' {
  const mainCpv = listing.mainCpv?.replace(/\D/g, '')
  if (mainCpv) return rules.cpvPrefixes.some((prefix) => mainCpv.startsWith(prefix)) ? 'it' : 'other'
  const descriptors = (listing.descriptors ?? []).map(normalize)
  if (descriptors.length === 0) return 'none'
  return descriptors.some((descriptor) => rules.descriptors.has(descriptor)) ? 'it' : 'other'
}

/** Appel d'offres de services informatiques ou de logiciels : classification et intitulé concordent (voir en tête). */
export function isItTender(listing: Pick<Listing, 'organisationId' | 'title' | 'mainCpv' | 'descriptors'>, rules: ItRules = DEFAULT_IT_RULES): boolean {
  const title = normalize(listing.title)
  if (rules.exclusions.some((phrase) => containsPhrase(title, phrase))) return false
  const keyword = mentionsTenderKeyword(listing.title, rules)
  const followed = listing.organisationId !== OTHER_BUYERS_ID
  const titleSaysIt = keyword || (followed && mentionsIt(listing.title, rules))
  switch (classification(listing, rules)) {
    case 'other':
      return false
    case 'none':
      return followed && titleSaysIt
    case 'it': {
      // CPV 72 comprend aussi les réseaux et l'hébergement : hors périmètre quand l'intitulé n'en dit pas plus.
      const infrastructure = rules.infrastructure.some((phrase) => containsPhrase(title, phrase))
      return keyword || (titleSaysIt && !infrastructure)
    }
  }
}

/** Offre d'emploi d'un métier informatique ou numérique, d'après son intitulé et sa catégorie (domaine, département). */
export function isItJob(listing: Pick<Listing, 'title' | 'details'>, rules: ItRules = DEFAULT_IT_RULES): boolean {
  return mentionsIt([listing.title, ...listing.details].join(' \n '), rules)
}

export function isItListing(listing: Listing, rules: ItRules = DEFAULT_IT_RULES): boolean {
  return listing.kind === 'tender' ? isItTender(listing, rules) : isItJob(listing, rules)
}

/**
 * Lecture d'une source réduite aux offres informatiques : les autres passent dans `ignoredIds` (retenues comme vues,
 * jamais envoyées), si bien que le nombre d'annonces lues, qui sert à repérer une source qui se vide, ne change pas.
 * Élargir le périmètre plus tard ne renverra pas ces offres-là (voir README, « Périmètre informatique »).
 */
export function scopeToIt(batch: SourceBatch, rules: ItRules = DEFAULT_IT_RULES): { batch: SourceBatch; outOfScope: string[] } {
  if (!rules.enabled) return { batch, outOfScope: [] }
  const listings: Listing[] = []
  const outOfScope: string[] = []
  for (const listing of batch.listings) {
    if (isItListing(listing, rules)) listings.push(listing)
    else outOfScope.push(listing.id)
  }
  return { batch: { ...batch, listings, ignoredIds: [...batch.ignoredIds, ...outOfScope] }, outOfScope }
}
