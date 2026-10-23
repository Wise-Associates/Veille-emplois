import * as cheerio from 'cheerio'

export interface RssItem {
  title: string
  link: string
  guid?: string
  pubDate?: string
  categories: string[]
  /** Contenu HTML de <description>. */
  description?: string
  /** Contenu HTML complet de <content:encoded> (WordPress), plus riche que <description>. */
  content?: string
}

/** Éléments d'un flux RSS 2.0, textes décodés (entités HTML comprises). */
export function parseRssItems(xml: string): RssItem[] {
  const $ = cheerio.load(xml, { xml: true })
  if ($('rss > channel').length === 0) throw new Error("Le document reçu n'est pas un flux RSS : la source a peut-être changé.")
  return $('item')
    .toArray()
    .map((element) => {
      const item = $(element)
      const field = (name: string) => item.children(name).first().text().trim() || undefined
      return {
        title: field('title') ?? '',
        link: field('link') ?? '',
        guid: field('guid'),
        pubDate: field('pubDate'),
        categories: item
          .children('category')
          .toArray()
          .map((category) => $(category).text().trim())
          .filter(Boolean),
        description: field('description'),
        content: field('content\\:encoded'),
      }
    })
}
