// Mise en forme commune aux e-mails (offres et récapitulatif). Les textes et liens viennent de sites tiers : tout est
// échappé, et seuls les liens http(s) sont rendus cliquables. Styles en ligne : la plupart des messageries ignorent
// les feuilles de style.

import { frenchDay, frenchDeadline } from '../dates.js'
import type { Listing } from '../listing.js'

export interface RenderedEmail {
  subject: string
  text: string
  html: string
}

/** En français, 0 et 1 prennent le singulier. */
export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count <= 1 ? singular : pluralForm}`
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function safeUrl(value: string): string | null {
  if (!URL.canParse(value)) return null
  const url = new URL(value)
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
}

/** Précisions d'une annonce sur une ligne : détails, lieu, dates. */
export function metaParts(listing: Listing): string[] {
  return [
    ...listing.details,
    ...(listing.location ? [listing.location] : []),
    ...(listing.publishedOn ? [`Publié le ${frenchDay(listing.publishedOn)}`] : []),
    ...(listing.deadline ? [`Date limite : ${frenchDeadline(listing.deadline)}`] : []),
  ]
}

export const STYLE = {
  body: 'font-family:Arial,Helvetica,sans-serif;color:#1f2937;font-size:14px;line-height:1.5;max-width:720px',
  h1: 'font-size:20px;margin:0 0 16px',
  h2: 'font-size:17px;margin:24px 0 8px;border-bottom:1px solid #d1d5db;padding-bottom:4px',
  h3: 'font-size:15px;margin:16px 0 4px;color:#374151',
  alert: 'background:#fef3c7;border:1px solid #f59e0b;padding:8px 12px;margin:0 0 16px',
  item: 'margin:0 0 10px',
  meta: 'color:#4b5563;font-size:13px',
  muted: 'color:#6b7280;font-size:12px',
  label: 'color:#4b5563;padding:2px 12px 2px 0;vertical-align:top;white-space:nowrap',
}
