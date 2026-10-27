// Comparaison d'expressions sans accents, majuscules ni ponctuation : noms d'acheteur (buyer-match.ts) et périmètre
// informatique (it-scope.ts). Sans import : les réglages (src/settings/) s'en servent sans cycle d'imports.

/** Minuscules, sans accents, chaque suite de caractères non alphanumériques remplacée par une espace. */
export function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Expression saisie dans les réglages (« Développeur* », « système d'information ») mise sous la forme comparée :
 * normalisée mot à mot, `*` final d'un mot gardé (début de mot). Le résultat ne contient que `[a-z0-9 *]` : il peut
 * servir à construire une expression régulière (containsPhrase). Chaîne vide : rien à chercher.
 */
export function normalizePhrase(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((word) => {
      const prefix = word.endsWith('*')
      const core = normalize(word.replace(/\*+$/, ''))
      return core ? `${core}${prefix ? '*' : ''}` : ''
    })
    .filter(Boolean)
    .join(' ')
}

const phrasePatterns = new Map<string, RegExp>()

/** Vrai si le texte normalisé contient l'expression normalisée en mots entiers (`*` final : début de mot). */
export function containsPhrase(normalizedText: string, phrase: string): boolean {
  let pattern = phrasePatterns.get(phrase)
  if (!pattern) {
    const words = phrase.split(' ').map((word) => (word.endsWith('*') ? `${word.slice(0, -1)}[a-z0-9]*` : word))
    pattern = new RegExp(`(?:^| )${words.join(' ')}(?: |$)`)
    phrasePatterns.set(phrase, pattern)
  }
  return pattern.test(normalizedText)
}
