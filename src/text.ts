// Conversion des descriptions HTML des sites (flux RSS, API, pages d'offres) en texte brut lisible dans un e-mail.

import * as cheerio from 'cheerio'

/** Au-delà, la description est coupée : une offre fait rarement plus de quelques milliers de caractères. */
export const MAX_DESCRIPTION_CHARS = 8_000

const BLOCKS = 'p, div, section, article, li, tr, h1, h2, h3, h4, h5, h6, ul, ol, table'

/** Texte brut d'un fragment HTML : paragraphes et listes gardés, espaces superflus retirés, longueur bornée. */
export function htmlToText(html: string): string {
  const $ = cheerio.load(`<body>${html}</body>`)
  $('script, style').remove()
  $('br').replaceWith('\n')
  $('li').each((_, element) => {
    $(element).prepend('- ')
  })
  $(BLOCKS).each((_, element) => {
    $(element).append('\n')
  })
  return limitText($('body').text())
}

/**
 * Lien web (http ou https) saisi par un acheteur dans un avis, rendu cliquable dans l'e-mail, ou undefined. Écartés :
 * les autres protocoles, les identifiants (« https://site-officiel@autre-site/… » mène à autre-site), les adresses IP
 * et les noms sans domaine (réseau interne de celui qui clique). Le BOAMP écrit les adresses avec des entités HTML
 * (« …?id=1&amp;lot=2 ») : elles sont décodées.
 */
export function webUrl(value: string | undefined): string | undefined {
  const decoded = value?.trim().replaceAll('&amp;', '&')
  if (!decoded || !URL.canParse(decoded)) return undefined
  const url = new URL(decoded)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  if (url.username || url.password || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(url.hostname)) return undefined
  return url.href
}

/** Espaces normalisés, trois sauts de ligne ou plus réduits à deux, longueur bornée. */
export function limitText(text: string): string {
  const clean = text
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return clean.length > MAX_DESCRIPTION_CHARS ? `${clean.slice(0, MAX_DESCRIPTION_CHARS).trimEnd()}…` : clean
}
