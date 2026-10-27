// Recherche des appels d'offres chez tous les acheteurs (ADR 0006) : au BOAMP et dans TED, une requête par famille de
// mots-clés et une par classification informatique (descripteurs du BOAMP, codes CPV dans TED), sur l'intitulé des avis.
// Le texte complet d'un avis ne s'y prête pas : « dématérialisation » ou « signature électronique » figurent dans les
// modalités de dépôt de presque tous. Les recherches des deux sites ignorent l'ordre des mots et les mots d'une lettre :
// chaque avis renvoyé est revérifié sur les expressions exactes (isItTender).

import { itRulesFrom, type ItRules } from '../it-scope.js'
import { normalizePhrase } from '../phrases.js'
import type { VeilleSettings } from '../settings/veille-settings.js'

export interface AllBuyersSearch {
  /** Mots cherchés, par famille : expressions sous leur forme comparée (`[a-z0-9 *]`) et sigles (`[A-Z0-9]`). */
  families: { id: string; label: string; phrases: string[]; acronyms: string[] }[]
  /** Classification informatique : préfixes CPV (TED) et descripteurs du BOAMP, sans guillemets (réglages validés). */
  cpvPrefixes: string[]
  boampDescriptors: string[]
  /** Règles du périmètre, pour écarter dès la lecture les avis renvoyés par erreur (mots dans le désordre). */
  rules: ItRules
}

/** Recherche du passage, ou null si les réglages limitent la veille aux organismes suivis. */
export function allBuyersSearchFrom(settings: VeilleSettings): AllBuyersSearch | null {
  if (!settings.tenderKeywords.allBuyers) return null
  return {
    families: settings.tenderKeywords.families.map((family) => ({
      id: family.id,
      label: family.label,
      phrases: family.phrases.map(normalizePhrase),
      acronyms: family.acronyms,
    })),
    cpvPrefixes: settings.itScope.cpvPrefixes,
    boampDescriptors: settings.itScope.boampDescriptors,
    rules: itRulesFrom(settings),
  }
}
