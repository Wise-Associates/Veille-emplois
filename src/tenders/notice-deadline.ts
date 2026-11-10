// Date limite écrite dans l'avis officiel en PDF (BOAMP, TED) : dernier recours quand ni les données de la source ni la
// page de l'offre n'en donnent (avis européens du BOAMP dont le champ `datelimitereponse` est vide et dont les données
// eForms n'en ont pas). ADR 0009 : le texte de l'avis est lu en mémoire pour cette seule ligne ; l'avis nomme aussi le
// contact de l'acheteur, rien d'autre n'est gardé, journalisé ni écrit dans l'e-mail.

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { parisLocalIso, pickDeadline } from '../dates.js'

/** Un avis fait 1 à 15 pages (relevé du 10/11/2026) : au-delà, le reste n'est pas lu. */
const MAX_PAGES = 40

/**
 * Lignes de date limite des avis, telles que le BOAMP et TED les écrivent (relevé du 10/11/2026) :
 * « Date limite de réception des demandes de participation:30/11/2026à 12:00 » (BOAMP),
 * « Date limite de réception des offres: 04/11/2026 11:00:00 (UTC+02:00) » (TED). Jamais « Date limite de demande
 * d'informations complémentaires » (questions des candidats, plus tôt).
 */
const DEADLINE_LINE = new RegExp(
  String.raw`Date\s+limite\s+de\s+r[ée]ception\s+des\s+(?:offres|demandes\s+de\s+participation|candidatures|plis)` +
    String.raw`(?:\s+ou\s+des\s+demandes\s+de\s+participation)?\s*:\s*(\d{2})\/(\d{2})\/(\d{4})` +
    String.raw`(?:\s*(?:à\s*)?(\d{1,2})\s*[:h]\s*(\d{2})(?::\d{2})?(?:\s*\(UTC\s*([+-]\d{2}:\d{2})\))?)?`,
  'gi',
)

/**
 * Date limite d'un avis d'après son texte, celle que retient `pickDeadline` au jour `today` si l'avis en donne plusieurs
 * (lots ; candidatures avant les offres), au format de `Listing.deadline` : AAAA-MM-JJ, ou date-heure ISO (heure de Paris
 * sans fuseau écrit). undefined sans ligne de date limite ou pour une date impossible.
 */
export function deadlineFromNoticeText(text: string, today: string): string | undefined {
  const found = [...text.matchAll(DEADLINE_LINE)].flatMap((match) => {
    const [, dd, mm, yyyy, hours, minutes, offset] = match
    const day = `${yyyy}-${mm}-${dd}`
    const date = new Date(`${day}T00:00:00Z`)
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) return []
    if (hours === undefined || minutes === undefined) return [day]
    if (Number(hours) > 23 || Number(minutes) > 59) return []
    const time = `${hours.padStart(2, '0')}:${minutes}`
    return [offset ? `${day}T${time}:00${offset}` : parisLocalIso(day, time)]
  })
  return pickDeadline(found, today)
}

/**
 * Texte d'un PDF (MAX_PAGES premières pages). Lit une copie : PDF.js peut détacher le tableau reçu, et le PDF est
 * ensuite joint à l'e-mail. Texte seulement : PDF.js 6 n'évalue plus de code, aucune police n'est chargée
 * (`disableFontFace`), ni formulaire XFA. Lève une erreur pour un fichier illisible.
 */
export async function pdfText(content: Uint8Array): Promise<string> {
  const task = getDocument({ data: content.slice(), disableFontFace: true, useSystemFonts: false, enableXfa: false, verbosity: 0 })
  try {
    const document = await task.promise
    const pages: string[] = []
    for (let number = 1; number <= Math.min(document.numPages, MAX_PAGES); number++) {
      const { items } = await (await document.getPage(number)).getTextContent()
      pages.push(items.map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : '')).join(''))
    }
    return pages.join('\n')
  } finally {
    await task.destroy()
  }
}
