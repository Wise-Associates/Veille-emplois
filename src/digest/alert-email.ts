// Alerte envoyée à l'équipe (MAIL_TO) quand un passage échoue : elle remplace le ticket que le workflow GitHub ouvrait
// (ADR 0010). Les problèmes sont les messages d'erreur du passage, écrits pour ne jamais contenir de secret ni de
// donnée personnelle. Rendu pur, testé dans alert-email.spec.ts.

import { frenchDeadline } from '../dates.js'
import { escapeHtml, STYLE, type RenderedEmail } from './format.js'

export interface RunAlert {
  /** Début du passage. */
  startedAt: Date
  problems: string[]
  /** État enregistré : les offres déjà envoyées ne repartiront pas. */
  stateSaved: boolean
}

export function renderRunAlert(alert: RunAlert): RenderedEmail {
  const when = frenchDeadline(alert.startedAt.toISOString())
  const subject = `Veille marchés et emplois — échec du passage du ${when}`
  const state = alert.stateSaved
    ? "État enregistré : les offres déjà envoyées ne repartiront pas. Les autres partiront au passage suivant."
    : "État non enregistré : les offres envoyées pendant ce passage repartiront au suivant (MyBestConsultant écarte les doublons)."
  const advice =
    'Sur le serveur : « sudo -u deploy docker logs --since 12h veille » donne le journal du passage. ' +
    'Causes et corrections : docs/deploiement-vps.md du dépôt, partie « Dépannage ».'
  const text = [
    `Le passage de la veille du ${when} (heure de Paris) a rencontré un problème :`,
    '',
    ...alert.problems.map((problem) => `- ${problem}`),
    '',
    state,
    '',
    advice,
  ].join('\n')
  const html = [
    `<div style="${STYLE.body}">`,
    `<h1 style="${STYLE.h1}">${escapeHtml(subject)}</h1>`,
    `<p>Le passage de la veille du ${escapeHtml(when)} (heure de Paris) a rencontré un problème :</p>`,
    `<ul>${alert.problems.map((problem) => `<li style="${STYLE.item}">${escapeHtml(problem)}</li>`).join('')}</ul>`,
    `<p style="${STYLE.alert}">${escapeHtml(state)}</p>`,
    `<p style="${STYLE.muted}">${escapeHtml(advice)}</p>`,
    '</div>',
  ].join('\n')
  return { subject, text, html }
}
