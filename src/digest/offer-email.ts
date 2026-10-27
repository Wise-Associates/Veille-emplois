// E-mail d'une offre, envoyé à la boîte AO de MyBestConsultant : son IA lit une offre par e-mail (au-delà d'une
// dizaine, sa réponse est coupée) et garde une seule date limite par e-mail. Les libellés (« Client », « Lieu »,
// « Date limite ») sont ceux que sa consigne d'extraction attend ; « Client » doit nommer l'organisme, car un e-mail
// envoyé depuis nos domaines prend pour client celui que cite le texte (ADR 0004 de MyBestConsultant).
// Rendu pur, testé dans offer-email.spec.ts.

import { frenchDeadline } from '../dates.js'
import type { Listing } from '../listing.js'
import { organisationName, ORGANISATIONS, type Organisation } from '../organisations.js'
import { escapeHtml, safeUrl, STYLE, type RenderedEmail } from './format.js'

const KIND = {
  tender: { label: "Appel d'offres", deadline: 'Date limite de réponse', link: 'Avis officiel' },
  job: { label: "Offre d'emploi", deadline: 'Date limite de candidature', link: 'Offre en ligne' },
} as const

/** Objet limité pour rester lisible dans les messageries. */
const MAX_SUBJECT = 180

const FOOTER = 'Annonce relevée automatiquement par la veille marchés et emplois, à partir de sources publiques.'

export function renderOfferEmail(listing: Listing, organisations: readonly Organisation[] = ORGANISATIONS): RenderedEmail {
  const kind = KIND[listing.kind]
  const organisation = organisationName(listing.organisationId, organisations)
  const url = safeUrl(listing.url)
  const subject = `${kind.label} — ${organisation} — ${listing.title}`.replace(/\s+/g, ' ')

  const fields: [string, string][] = [
    ['Intitulé', listing.title],
    ['Client', organisation],
    ...(listing.location ? [['Lieu', listing.location] as [string, string]] : []),
    ...(listing.details.length ? [['Précisions', listing.details.join(' · ')] as [string, string]] : []),
    // Pas de date de publication : MyBestConsultant n'en garde pas, et son IA classe une date qui n'est ni un
    // démarrage ni une date limite d'après son jour de la semaine — elle deviendrait une fausse date limite.
    ...(listing.deadline ? [[kind.deadline, frenchDeadline(listing.deadline)] as [string, string]] : []),
    ['Référence', listing.id],
    [kind.link, url ?? 'lien indisponible'],
  ]
  const description = listing.description?.trim() || 'Pas de description dans la source : voir l\'annonce en ligne.'

  const text = [
    `${kind.label} — ${organisation}`,
    '',
    ...fields.map(([label, value]) => `${label} : ${value}`),
    '',
    'Description',
    '-----------',
    description,
    '',
    '--',
    FOOTER,
  ].join('\n')

  const rows = fields
    .map(([label, value]) => {
      const cell = label === kind.link && url ? `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>` : escapeHtml(value)
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

  return { subject: subject.length > MAX_SUBJECT ? `${subject.slice(0, MAX_SUBJECT - 1)}…` : subject, text, html }
}
