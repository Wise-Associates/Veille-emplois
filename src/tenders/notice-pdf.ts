// Avis officiel en PDF d'un appel d'offres (BOAMP, TED), joint à l'e-mail de l'offre (ADR 0009). Téléchargé au moment
// d'envoyer l'offre, depuis ces deux sites seulement : leurs avis sont en réutilisation libre (Licence Ouverte, décision
// de la Commission du 12/12/2011), et leur robots.txt n'interdit pas ces adresses (vérifié le 05/11/2026). Le dossier de
// consultation (DCE), sur la plateforme de chaque acheteur, n'est jamais téléchargé.
//
// L'avis nomme le contact de l'acheteur (nom, téléphone, e-mail) : le PDF est joint tel quel à la boîte AO interne. Son
// texte n'est lu que pour une offre sans date limite, et seulement la ligne de date limite (notice-deadline.ts) ; rien
// d'autre n'en est gardé ni journalisé.

import { Injectable } from '@nestjs/common'
import type { EmailAttachment } from '../digest/format.js'
import { HttpClient, OFFER_PAGE_REQUEST } from '../http/http-client.js'
import { deadlineFromNoticeText, pdfText } from './notice-deadline.js'

const PDF_HOSTS = new Set(['www.boamp.fr', 'ted.europa.eu'])
/**
 * Un avis fait 50 à 300 Ko (relevé du 05/11/2026). Au-delà de 5 Mo, sa lecture s'arrête et il n'est pas joint : un
 * message trop lourd serait refusé par le serveur d'envoi.
 */
export const MAX_NOTICE_PDF_BYTES = 5 * 1024 * 1024

/** Adresse d'un avis officiel : https, sur le BOAMP ou TED (redirections comprises). */
const isNoticePdfUrl = (url: URL) => url.protocol === 'https:' && PDF_HOSTS.has(url.hostname)

/** Nom de la pièce jointe, d'après la référence de l'avis ; tout caractère hors lettres, chiffres et tirets remplacé. */
export function noticePdfFilename(reference: string): string {
  return `avis-${reference.replace(/[^\w-]+/g, '_')}.pdf`
}

/** Fichier reçu : un vrai PDF (signature « %PDF- »), pas une page d'erreur servie à sa place. */
export function checkNoticePdf(body: Uint8Array): void {
  if (new TextDecoder().decode(body.subarray(0, 5)) !== '%PDF-') throw new Error("le fichier reçu n'est pas un PDF")
}

@Injectable()
export class NoticePdfReader {
  constructor(private readonly http: HttpClient) {}

  /**
   * Avis officiel en PDF, prêt à joindre. Délai court et sans nouvelle tentative, comme une page d'offre : un site lent
   * ne doit pas faire dépasser la durée du passage. Lève une erreur en cas d'échec (l'offre part alors sans son PDF).
   */
  async read(url: string, reference: string): Promise<EmailAttachment> {
    const parsed = URL.canParse(url) ? new URL(url) : null
    if (!parsed || !isNoticePdfUrl(parsed)) throw new Error(`adresse d'avis PDF inattendue (${parsed?.origin ?? 'illisible'})`)
    const body = await this.http.binary(parsed.href, {
      ...OFFER_PAGE_REQUEST,
      headers: { Accept: 'application/pdf' },
      allowRedirect: isNoticePdfUrl,
      maxBytes: MAX_NOTICE_PDF_BYTES,
    })
    checkNoticePdf(body)
    return { filename: noticePdfFilename(reference), content: body, contentType: 'application/pdf' }
  }

  /**
   * Date limite écrite dans l'avis au jour `today` (format de `Listing.deadline`, règle de `pickDeadline`), ou undefined
   * s'il n'en donne pas. Lève une erreur pour un PDF illisible.
   */
  async deadline(pdf: EmailAttachment, today: string): Promise<string | undefined> {
    return deadlineFromNoticeText(await pdfText(pdf.content), today)
  }
}
