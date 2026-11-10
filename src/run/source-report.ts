// Rapport d'un passage, source par source, envoyé à MyBestConsultant pour son suivi des sources (ADR 0012) : lecture
// réussie ou en échec, annonces lues, écartées, nouvelles, envoyées, en attente, points à vérifier. Seulement des nombres,
// des libellés de sources et des messages d'erreur ou d'alerte (au plus l'intitulé public d'une offre refusée par le
// serveur d'envoi) : jamais le texte d'une annonce ni un contact.
// Même format que src/lib/veille/run-report.ts de MyBestConsultant (`schemaVersion`) : toute évolution dans les deux
// projets. Règle pure, testée dans source-report.spec.ts.

import type { ListingKind } from '../listing.js'
import type { ChosenSettings } from '../settings/veille-settings.js'
import type { NewListing, SourceOutcome } from '../state/run-state.js'

export const SOURCE_REPORT_VERSION = 1

/** Un message d'erreur ou d'alerte est coupé à cette longueur (MyBestConsultant refuse au-delà). */
export const MAX_MESSAGE_LENGTH = 300
/** Alertes gardées par source, et hors source (une par offre refusée possible) : MyBestConsultant refuse au-delà. */
export const MAX_SOURCE_WARNINGS = 20
export const MAX_OTHER_WARNINGS = 50

export interface SourceRunReport {
  /** Identifiant de la source (clé du fichier d'état), comme dans les réglages de MyBestConsultant. */
  id: string
  label: string
  kind: ListingKind
  ok: boolean
  /** Erreur de lecture (ok = false), sinon null. */
  error: string | null
  /** Annonces informatiques lues (toutes, déjà vues comprises). */
  listed: number
  /** Nouvelles annonces écartées par le périmètre informatique. */
  outOfScope: number
  /** Nouvelles annonces du périmètre. */
  new: number
  /** Envoyées à la boîte AO pendant ce passage. */
  sent: number
  /** Non envoyées car leur date limite était passée. */
  outdated: number
  /** Non envoyées pendant ce passage (plafond, budget de temps, envoi interrompu) : elles repartiront. */
  pending: number
  /** Points à vérifier propres à cette source (page modifiée, avis PDF illisibles…). */
  warnings: string[]
}

export interface RunReportPayload {
  schemaVersion: typeof SOURCE_REPORT_VERSION
  /** Début du passage (ISO) : identifie le passage, un rapport renvoyé n'est enregistré qu'une fois. */
  startedAt: string
  finishedAt: string
  /** Réglages utilisés : ceux de MyBestConsultant, la dernière version connue, ou ceux du dépôt. */
  settings: { origin: ChosenSettings['origin']; version: number | null }
  /** Envoi des offres arrêté par le serveur d'envoi, sinon null. */
  deliveryError: string | null
  sources: SourceRunReport[]
  /** Points à vérifier qui ne concernent aucune source (réglages, fichier d'état, serveur d'envoi). */
  otherWarnings: { label: string; message: string }[]
}

export interface RunFacts {
  startedAt: Date
  finishedAt: Date
  settings: Pick<ChosenSettings, 'origin' | 'snapshot'>
  outcomes: SourceOutcome[]
  /** Nouvelles annonces hors informatique, par identifiant de source. */
  outOfScopeBySource: ReadonlyMap<string, number>
  newListings: NewListing[]
  sent: NewListing[]
  outdated: NewListing[]
  deliveryError: string | null
  /** Points à vérifier du passage, rattachés à une source par son libellé. */
  warnings: { label: string; message: string }[]
}

const clip = (text: string) => (text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : text)

const countBySource = (listings: NewListing[]) => {
  const counts = new Map<string, number>()
  for (const listing of listings) counts.set(listing.sourceId, (counts.get(listing.sourceId) ?? 0) + 1)
  return counts
}

export function buildRunReport(facts: RunFacts): RunReportPayload {
  const created = countBySource(facts.newListings)
  const sent = countBySource(facts.sent)
  const outdated = countBySource(facts.outdated)
  // Les alertes du passage ne connaissent que le libellé de la source (récapitulatif) : rattachées par lui.
  const idByLabel = new Map<string, string>()
  for (const outcome of facts.outcomes) if (!idByLabel.has(outcome.label)) idByLabel.set(outcome.label, outcome.sourceId)
  const warningsBySource = new Map<string, string[]>()
  const otherWarnings: RunReportPayload['otherWarnings'] = []
  for (const warning of facts.warnings) {
    const id = idByLabel.get(warning.label)
    if (id) warningsBySource.set(id, [...(warningsBySource.get(id) ?? []), clip(warning.message)])
    else otherWarnings.push({ label: clip(warning.label), message: clip(warning.message) })
  }

  const sources = facts.outcomes.map((outcome): SourceRunReport => {
    const id = outcome.sourceId
    const fresh = created.get(id) ?? 0
    const handled = (sent.get(id) ?? 0) + (outdated.get(id) ?? 0)
    return {
      id,
      label: clip(outcome.label),
      kind: outcome.kind,
      ok: outcome.ok,
      error: outcome.ok ? null : clip(outcome.error),
      listed: outcome.ok ? outcome.batch.listings.length : 0,
      outOfScope: facts.outOfScopeBySource.get(id) ?? 0,
      new: fresh,
      sent: sent.get(id) ?? 0,
      outdated: outdated.get(id) ?? 0,
      pending: Math.max(0, fresh - handled),
      warnings: (warningsBySource.get(id) ?? []).slice(0, MAX_SOURCE_WARNINGS),
    }
  })

  return {
    schemaVersion: SOURCE_REPORT_VERSION,
    startedAt: facts.startedAt.toISOString(),
    finishedAt: facts.finishedAt.toISOString(),
    settings: { origin: facts.settings.origin, version: facts.settings.origin === 'defaults' ? null : (facts.settings.snapshot?.version ?? null) },
    deliveryError: facts.deliveryError === null ? null : clip(facts.deliveryError),
    sources,
    otherWarnings: otherWarnings.slice(0, MAX_OTHER_WARNINGS),
  }
}
