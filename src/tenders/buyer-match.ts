// Rattache un avis de marché à un organisme suivi d'après ses acheteurs (règles dans organisations.ts).
// Règles pures, testées dans buyer-match.spec.ts.

import { ORGANISATIONS, type Organisation, type OrganisationId, type TenderRule } from '../organisations.js'

export interface Buyer {
  name: string
  /** SIRET tel que saisi dans l'avis (espaces et ponctuation tolérés), absent sur beaucoup de petits avis. */
  siret?: string
}

export interface NoticeForMatching {
  /** Acheteurs de l'avis (plusieurs pour un achat groupé), jamais les titulaires ni l'instance de recours. */
  buyers: Buyer[]
  /** Intitulé et description de l'avis, pour les règles `requiredText`. */
  text: string
}

/** Minuscules, sans accents, chaque suite de caractères non alphanumériques remplacée par une espace. */
export function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const phrasePatterns = new Map<string, RegExp>()

/** Vrai si le texte normalisé contient l'expression en mots entiers (`*` final : début de mot). */
export function containsPhrase(normalizedText: string, phrase: string): boolean {
  let pattern = phrasePatterns.get(phrase)
  if (!pattern) {
    const words = phrase.split(' ').map((word) => (word.endsWith('*') ? `${word.slice(0, -1)}[a-z0-9]*` : word))
    pattern = new RegExp(`(?:^| )${words.join(' ')}(?: |$)`)
    phrasePatterns.set(phrase, pattern)
  }
  return pattern.test(normalizedText)
}

function buyerMatches(rule: TenderRule, buyer: Buyer): boolean {
  const siret = buyer.siret?.replace(/\D/g, '')
  if (siret && rule.sirens?.some((siren) => siret.startsWith(siren))) return true
  const name = normalize(buyer.name)
  return (
    (rule.names?.some((phrase) => containsPhrase(name, phrase)) ?? false) &&
    !(rule.excludedNames?.some((phrase) => containsPhrase(name, phrase)) ?? false)
  )
}

function ruleMatches(rule: TenderRule, notice: NoticeForMatching): boolean {
  if (!notice.buyers.some((buyer) => buyerMatches(rule, buyer))) return false
  if (!rule.requiredText) return true
  const text = normalize(notice.text)
  return rule.requiredText.some((phrase) => containsPhrase(text, phrase))
}

/** Premier organisme (dans l'ordre de la liste) dont une règle reconnaît l'avis, sinon null. */
export function matchOrganisation(
  notice: NoticeForMatching,
  organisations: readonly Organisation[] = ORGANISATIONS,
): OrganisationId | null {
  const organisation = organisations.find((o) => o.tenderRules.some((rule) => ruleMatches(rule, notice)))
  return organisation?.id ?? null
}
