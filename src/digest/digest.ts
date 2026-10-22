// Récapitulatif quotidien envoyé par e-mail (texte et HTML). Rendu pur, testé dans digest.spec.ts.
//
// Les titres et liens viennent de sites tiers : tout est échappé, et seuls les liens http(s) sont rendus cliquables.
// Styles en ligne : la plupart des messageries ignorent les feuilles de style.

import { frenchDay, frenchDeadline } from '../dates.js'
import type { Listing, ListingKind } from '../listing.js'
import { ORGANISATIONS } from '../organisations.js'
import type { RunReport } from '../state/run-state.js'

export interface Digest {
  subject: string
  text: string
  html: string
}

const SECTIONS: { kind: ListingKind; title: string }[] = [
  { kind: 'tender', title: "Appels d'offres" },
  { kind: 'job', title: "Offres d'emploi" },
]

/** En français, 0 et 1 prennent le singulier. */
function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count <= 1 ? singular : pluralForm}`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    // URL illisible : l'annonce est affichée sans lien plutôt que d'être perdue.
    return null
  }
}

function meta(listing: Listing): string[] {
  return [
    ...listing.details,
    ...(listing.location ? [listing.location] : []),
    ...(listing.publishedOn ? [`Publié le ${frenchDay(listing.publishedOn)}`] : []),
    ...(listing.deadline ? [`Date limite : ${frenchDeadline(listing.deadline)}`] : []),
  ]
}

/** Annonces d'une section, regroupées par organisme dans l'ordre de la liste des organismes. */
function groups(listings: Listing[], kind: ListingKind): { name: string; listings: Listing[] }[] {
  return ORGANISATIONS.map((organisation) => ({
    name: organisation.name,
    listings: listings
      .filter((l) => l.kind === kind && l.organisationId === organisation.id)
      .sort((a, b) => (b.publishedOn ?? '').localeCompare(a.publishedOn ?? '') || a.title.localeCompare(b.title, 'fr')),
  })).filter((group) => group.listings.length > 0)
}

function subject(report: RunReport, day: string): string {
  const tenders = report.newListings.filter((l) => l.kind === 'tender').length
  const jobs = report.newListings.length - tenders
  const parts = [
    ...(tenders ? [plural(tenders, "appel d'offres", "appels d'offres")] : []),
    ...(jobs ? [plural(jobs, "offre d'emploi", "offres d'emploi")] : []),
  ]
  const problems = report.failures.length + report.warnings.length
  const suffix = problems ? ` — ${plural(problems, 'source à vérifier', 'sources à vérifier')}` : ''
  return `Veille du ${frenchDay(day)} : ${parts.length ? parts.join(', ') : 'aucune nouveauté'}${suffix}`
}

const NOTHING_NEW = "Aucune nouvelle annonce aujourd'hui."
const FOOTER =
  'Sources : BOAMP, TED, Choisir le service public et les sites carrières des organismes. ' +
  'Message envoyé automatiquement par la veille marchés et emplois.'

function problemLines(report: RunReport): string[] {
  return [
    ...report.failures.map((f) => `${f.label} : ${f.error}`),
    ...report.warnings.map((w) => `${w.label} : ${w.message}`),
  ]
}

function initialisedLine(report: RunReport): string | null {
  if (!report.initialised.length) return null
  const sources = report.initialised.map((s) => `${s.label} (${plural(s.count, 'annonce enregistrée', 'annonces enregistrées')})`)
  return `Sources lues pour la première fois : ${sources.join(', ')}. Leurs nouveautés seront annoncées à partir du prochain passage.`
}

function renderText(report: RunReport, day: string): string {
  const lines = [`Veille du ${frenchDay(day)}`, '']
  const problems = problemLines(report)
  if (problems.length) lines.push('⚠ Sources à vérifier', ...problems.map((p) => `- ${p}`), '')
  if (!report.newListings.length) lines.push(NOTHING_NEW, '')
  for (const section of SECTIONS) {
    const sectionGroups = groups(report.newListings, section.kind)
    if (!sectionGroups.length) continue
    const heading = `${section.title} (${sectionGroups.reduce((total, group) => total + group.listings.length, 0)})`
    lines.push(heading, '='.repeat(heading.length), '')
    for (const group of sectionGroups) {
      lines.push(`${group.name}`)
      for (const listing of group.listings) {
        lines.push(`- ${listing.title}`, `  ${[...meta(listing), safeUrl(listing.url) ?? 'lien indisponible'].join(' · ')}`)
      }
      lines.push('')
    }
  }
  const initialised = initialisedLine(report)
  if (initialised) lines.push(initialised, '')
  lines.push('--', FOOTER)
  return lines.join('\n')
}

const STYLE = {
  body: 'font-family:Arial,Helvetica,sans-serif;color:#1f2937;font-size:14px;line-height:1.5;max-width:720px',
  h1: 'font-size:20px;margin:0 0 16px',
  h2: 'font-size:17px;margin:24px 0 8px;border-bottom:1px solid #d1d5db;padding-bottom:4px',
  h3: 'font-size:15px;margin:16px 0 4px;color:#374151',
  alert: 'background:#fef3c7;border:1px solid #f59e0b;padding:8px 12px;margin:0 0 16px',
  item: 'margin:0 0 10px',
  meta: 'color:#4b5563;font-size:13px',
  muted: 'color:#6b7280;font-size:12px',
}

function renderListingHtml(listing: Listing): string {
  const url = safeUrl(listing.url)
  const title = escapeHtml(listing.title)
  const heading = url ? `<a href="${escapeHtml(url)}">${title}</a>` : title
  const details = meta(listing).map(escapeHtml).join(' · ')
  return `<li style="${STYLE.item}">${heading}${details ? `<br><span style="${STYLE.meta}">${details}</span>` : ''}</li>`
}

function renderHtml(report: RunReport, day: string): string {
  const parts = [`<div style="${STYLE.body}">`, `<h1 style="${STYLE.h1}">Veille du ${frenchDay(day)}</h1>`]
  const problems = problemLines(report)
  if (problems.length) {
    parts.push(
      `<div style="${STYLE.alert}"><strong>⚠ Sources à vérifier</strong><ul>`,
      ...problems.map((p) => `<li>${escapeHtml(p)}</li>`),
      '</ul></div>',
    )
  }
  if (!report.newListings.length) parts.push(`<p>${NOTHING_NEW}</p>`)
  for (const section of SECTIONS) {
    const sectionGroups = groups(report.newListings, section.kind)
    if (!sectionGroups.length) continue
    const count = sectionGroups.reduce((total, group) => total + group.listings.length, 0)
    parts.push(`<h2 style="${STYLE.h2}">${section.title} (${count})</h2>`)
    for (const group of sectionGroups) {
      parts.push(`<h3 style="${STYLE.h3}">${escapeHtml(group.name)}</h3><ul>`, ...group.listings.map(renderListingHtml), '</ul>')
    }
  }
  const initialised = initialisedLine(report)
  if (initialised) parts.push(`<p style="${STYLE.muted}">${escapeHtml(initialised)}</p>`)
  parts.push(`<p style="${STYLE.muted}">${FOOTER}</p>`, '</div>')
  return parts.join('\n')
}

export function renderDigest(report: RunReport, day: string): Digest {
  return { subject: subject(report, day), text: renderText(report, day), html: renderHtml(report, day) }
}
