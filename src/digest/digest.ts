// Récapitulatif quotidien envoyé à l'équipe (texte et HTML) : offres envoyées à la boîte AO, offres en attente
// d'envoi, sources à vérifier. Rendu pur, testé dans digest.spec.ts.

import { frenchDay } from '../dates.js'
import type { Listing, ListingKind } from '../listing.js'
import { ORGANISATIONS } from '../organisations.js'
import type { RunReport } from '../state/run-state.js'
import { escapeHtml, metaParts, plural, safeUrl, STYLE, type RenderedEmail } from './format.js'

export interface DeliverySummary {
  /** Offres envoyées une à une à la boîte AO pendant ce passage. */
  sent: Listing[]
  /** Nouvelles offres non envoyées car leur date limite était déjà passée. */
  outdated: number
  /** Nouvelles offres écartées car hors du périmètre informatique (it-scope.ts). */
  outOfScope: number
  /** Nouvelles offres non envoyées (plafond du passage, envoi interrompu) : elles partiront aux passages suivants. */
  pending: number
  /** Nombre maximal d'offres envoyées par passage. */
  perRunLimit: number
  /** Durée maximale d'un passage, en minutes, au-delà de laquelle plus aucune offre n'est commencée. */
  timeBudgetMinutes: number
  /** Envoi des offres interrompu par le serveur d'envoi, ou null. */
  deliveryError: string | null
  failures: RunReport['failures']
  warnings: RunReport['warnings']
}

const SECTIONS: { kind: ListingKind; title: string }[] = [
  { kind: 'tender', title: "Appels d'offres" },
  { kind: 'job', title: "Offres d'emploi" },
]

/** Annonces d'une section, regroupées par organisme dans l'ordre de la liste des organismes. */
function groups(listings: Listing[], kind: ListingKind): { name: string; listings: Listing[] }[] {
  return ORGANISATIONS.map((organisation) => ({
    name: organisation.name,
    listings: listings
      .filter((l) => l.kind === kind && l.organisationId === organisation.id)
      .sort((a, b) => (b.publishedOn ?? '').localeCompare(a.publishedOn ?? '') || a.title.localeCompare(b.title, 'fr')),
  })).filter((group) => group.listings.length > 0)
}

/** Le passage a-t-il un point à vérifier (envoi interrompu, source en échec, avertissement) ? */
export function needsAttention(summary: DeliverySummary): boolean {
  return problemLines(summary).length > 0
}

function problemLines(summary: DeliverySummary): string[] {
  return [
    ...(summary.deliveryError ? [`Envoi des offres interrompu : ${summary.deliveryError}`] : []),
    ...summary.failures.map((f) => `${f.label} : ${f.error}`),
    ...summary.warnings.map((w) => `${w.label} : ${w.message}`),
  ]
}

function subject(summary: DeliverySummary, day: string): string {
  const tenders = summary.sent.filter((l) => l.kind === 'tender').length
  const jobs = summary.sent.length - tenders
  const parts = [
    ...(tenders ? [plural(tenders, "appel d'offres", "appels d'offres")] : []),
    ...(jobs ? [plural(jobs, "offre d'emploi", "offres d'emploi")] : []),
  ]
  // Accord : féminin si seulement des offres d'emploi, masculin dès qu'il y a un appel d'offres.
  const agreement = `envoy${tenders ? 'é' : 'ée'}${summary.sent.length > 1 ? 's' : ''}`
  const sent = parts.length ? `${parts.join(', ')} ${agreement}` : 'aucune nouveauté envoyée'
  const pending = summary.pending ? ` — ${summary.pending} en attente` : ''
  const problems = problemLines(summary).length
  const alert = problems ? ` — ${plural(problems, 'point à vérifier', 'points à vérifier')}` : ''
  return `Veille du ${frenchDay(day)} : ${sent}${pending}${alert}`
}

function pendingLine(summary: DeliverySummary): string | null {
  if (!summary.pending) return null
  return (
    `${plural(summary.pending, "nouvelle offre attend d'être envoyée", "nouvelles offres attendent d'être envoyées")} à la boîte AO ` +
    `(au plus ${summary.perRunLimit} par passage, en ${summary.timeBudgetMinutes} minutes au plus) : elles partiront aux ` +
    'passages suivants. Pour accélérer, relancez ' +
    'le workflow « Veille quotidienne » à la main.'
  )
}

function outdatedLine(summary: DeliverySummary): string | null {
  const parts = [
    ...(summary.outdated ? [`${plural(summary.outdated, 'nouvelle offre écartée', 'nouvelles offres écartées')} : date limite déjà passée.`] : []),
    ...(summary.outOfScope
      ? [`${plural(summary.outOfScope, 'nouvelle offre écartée', 'nouvelles offres écartées')} : hors projets informatiques.`]
      : []),
  ]
  return parts.length ? parts.join(' ') : null
}

const INTRO = 'Chaque offre ci-dessous a été envoyée dans son propre e-mail à la boîte AO de MyBestConsultant.'
const FOOTER =
  'Sources : BOAMP, TED, Choisir le service public et les sites carrières des organismes. ' +
  'Message envoyé automatiquement par la veille marchés et emplois.'

function renderText(summary: DeliverySummary, day: string): string {
  const lines = [`Veille du ${frenchDay(day)}`, '']
  const problems = problemLines(summary)
  if (problems.length) lines.push('⚠ Points à vérifier', ...problems.map((p) => `- ${p}`), '')
  const pending = pendingLine(summary)
  if (pending) lines.push(pending, '')
  const outdated = outdatedLine(summary)
  if (outdated) lines.push(outdated, '')
  lines.push(summary.sent.length ? INTRO : "Aucune nouvelle offre envoyée aujourd'hui.", '')
  for (const section of SECTIONS) {
    const sectionGroups = groups(summary.sent, section.kind)
    if (!sectionGroups.length) continue
    const heading = `${section.title} (${sectionGroups.reduce((total, group) => total + group.listings.length, 0)})`
    lines.push(heading, '='.repeat(heading.length), '')
    for (const group of sectionGroups) {
      lines.push(group.name)
      for (const listing of group.listings) {
        lines.push(`- ${listing.title}`, `  ${[...metaParts(listing), safeUrl(listing.url) ?? 'lien indisponible'].join(' · ')}`)
      }
      lines.push('')
    }
  }
  lines.push('--', FOOTER)
  return lines.join('\n')
}

function renderListingHtml(listing: Listing): string {
  const url = safeUrl(listing.url)
  const title = escapeHtml(listing.title)
  const heading = url ? `<a href="${escapeHtml(url)}">${title}</a>` : title
  const details = metaParts(listing).map(escapeHtml).join(' · ')
  return `<li style="${STYLE.item}">${heading}${details ? `<br><span style="${STYLE.meta}">${details}</span>` : ''}</li>`
}

function renderHtml(summary: DeliverySummary, day: string): string {
  const parts = [`<div style="${STYLE.body}">`, `<h1 style="${STYLE.h1}">Veille du ${frenchDay(day)}</h1>`]
  const problems = problemLines(summary)
  if (problems.length) {
    parts.push(
      `<div style="${STYLE.alert}"><strong>⚠ Points à vérifier</strong><ul>`,
      ...problems.map((p) => `<li>${escapeHtml(p)}</li>`),
      '</ul></div>',
    )
  }
  const pending = pendingLine(summary)
  if (pending) parts.push(`<p><strong>${escapeHtml(pending)}</strong></p>`)
  const outdated = outdatedLine(summary)
  if (outdated) parts.push(`<p style="${STYLE.meta}">${escapeHtml(outdated)}</p>`)
  parts.push(`<p>${summary.sent.length ? INTRO : "Aucune nouvelle offre envoyée aujourd'hui."}</p>`)
  for (const section of SECTIONS) {
    const sectionGroups = groups(summary.sent, section.kind)
    if (!sectionGroups.length) continue
    const count = sectionGroups.reduce((total, group) => total + group.listings.length, 0)
    parts.push(`<h2 style="${STYLE.h2}">${section.title} (${count})</h2>`)
    for (const group of sectionGroups) {
      parts.push(`<h3 style="${STYLE.h3}">${escapeHtml(group.name)}</h3><ul>`, ...group.listings.map(renderListingHtml), '</ul>')
    }
  }
  parts.push(`<p style="${STYLE.muted}">${FOOTER}</p>`, '</div>')
  return parts.join('\n')
}

export function renderDigest(summary: DeliverySummary, day: string): RenderedEmail {
  return { subject: subject(summary, day), text: renderText(summary, day), html: renderHtml(summary, day) }
}
