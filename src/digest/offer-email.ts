// E-mail d'une offre, envoyé à la boîte AO de MyBestConsultant : son IA lit une offre par e-mail (au-delà d'une
// dizaine, sa réponse est coupée) et garde une seule date limite par e-mail. Les libellés (« Client », « Lieu »,
// « Date limite ») sont ceux que sa consigne d'extraction attend ; « Client » doit nommer l'organisme, car un e-mail
// envoyé depuis nos domaines prend pour client celui que cite le texte (ADR 0004 de MyBestConsultant).
// Rendu pur, testé dans offer-email.spec.ts.

import { frenchDeadline } from '../dates.js'
import type { Listing } from '../listing.js'
import { organisationName, ORGANISATIONS, type Organisation } from '../organisations.js'
import { escapeHtml, safeUrl, STYLE, type EmailAttachment, type RenderedEmail } from './format.js'

const KIND = {
  tender: { label: "Appel d'offres", deadline: 'Date limite de réponse', link: 'Avis officiel' },
  job: { label: "Offre d'emploi", deadline: 'Date limite de candidature', link: 'Offre en ligne' },
} as const

/** Objet limité pour rester lisible dans les messageries. */
const MAX_SUBJECT = 180

const FOOTER = 'Annonce relevée automatiquement par la veille marchés et emplois, à partir de sources publiques.'

/** Ligne du tableau de l'e-mail ; `href` : lien http(s) déjà vérifié, rendu cliquable dans la version HTML. */
type Field = { label: string; value: string; href?: string }

/**
 * `attachments` : avis officiel en PDF d'un appel d'offres (déjà téléchargé), joint au message et annoncé dans son
 * texte. MyBestConsultant lit le texte des PDF joints et garde la pièce jointe, téléchargeable depuis la page de l'offre.
 */
export function renderOfferEmail(
  listing: Listing,
  organisations: readonly Organisation[] = ORGANISATIONS,
  attachments: readonly EmailAttachment[] = [],
): RenderedEmail {
  const kind = KIND[listing.kind]
  // Avis d'un acheteur non suivi (recherche chez tous les acheteurs) : l'acheteur est le client.
  const organisation = listing.buyer ?? organisationName(listing.organisationId, organisations)
  const url = safeUrl(listing.url)
  const documentsUrl = listing.documentsUrl ? safeUrl(listing.documentsUrl) : null
  const subject = `${kind.label} — ${organisation} — ${listing.title}`.replace(/\s+/g, ' ')

  const fields: Field[] = [
    { label: 'Intitulé', value: listing.title },
    { label: 'Client', value: organisation },
    ...(listing.location ? [{ label: 'Lieu', value: listing.location }] : []),
    ...(listing.details.length ? [{ label: 'Précisions', value: listing.details.join(' · ') }] : []),
    // Pas de date de publication : MyBestConsultant n'en garde pas, et son IA classe une date qui n'est ni un
    // démarrage ni une date limite d'après son jour de la semaine — elle deviendrait une fausse date limite.
    ...(listing.deadline ? [{ label: kind.deadline, value: frenchDeadline(listing.deadline) }] : []),
    { label: 'Référence', value: listing.id },
    url ? { label: kind.link, value: url, href: url } : { label: kind.link, value: 'lien indisponible' },
    ...(attachments.length
      ? [{ label: `${kind.link} (PDF)`, value: `joint à cet e-mail (${attachments.map((a) => a.filename).join(', ')})` }]
      : []),
    // Lien saisi par l'acheteur vers sa plateforme : le dossier n'est pas téléchargé par la veille (ADR 0009).
    ...(documentsUrl ? [{ label: 'Dossier de consultation', value: documentsUrl, href: documentsUrl }] : []),
  ]
  const description = listing.description?.trim() || 'Pas de description dans la source : voir l\'annonce en ligne.'

  const text = [
    `${kind.label} — ${organisation}`,
    '',
    ...fields.map(({ label, value }) => `${label} : ${value}`),
    '',
    'Description',
    '-----------',
    description,
    '',
    '--',
    FOOTER,
  ].join('\n')

  const rows = fields
    .map(({ label, value, href }) => {
      const cell = href ? `<a href="${escapeHtml(href)}">${escapeHtml(value)}</a>` : escapeHtml(value)
      return `<tr><td style="${STYLE.label}">${escapeHtml(label)}</td><td>${cell}</td></tr>`
    })
    .join('\n')
  const paragraphs = description
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`)
    .join('\n')
  const html = [
    `<div style="${STYLE.body}">`,
    `<h1 style="${STYLE.h1}">${escapeHtml(kind.label)} — ${escapeHtml(organisation)}</h1>`,
    `<table>${rows}</table>`,
    `<h2 style="${STYLE.h2}">Description</h2>`,
    paragraphs,
    `<p style="${STYLE.muted}">${escapeHtml(FOOTER)}</p>`,
    '</div>',
  ].join('\n')

  return {
    subject: subject.length > MAX_SUBJECT ? `${subject.slice(0, MAX_SUBJECT - 1)}…` : subject,
    text,
    html,
    ...(attachments.length ? { attachments: [...attachments] } : {}),
  }
}
