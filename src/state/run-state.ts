// Ce que la veille retient d'un passage à l'autre, et le calcul des nouveautés d'un passage.
// Règles pures (sans fichier ni réseau), testées dans run-state.spec.ts.
//
// Une annonce est nouvelle si son identifiant n'a jamais été vu dans sa source : les dates de publication des
// sources ne sont pas fiables (le flux de Choisir le service public donne la date de mise à jour, d'autres une
// date relative ou rien).

import { z } from 'zod'
import { addDays, frenchDay } from '../dates.js'
import type { Listing, ListingKind, SourceBatch } from '../listing.js'
import { ORGANISATIONS, type Organisation } from '../organisations.js'

/**
 * Une annonce absente de sa source est oubliée quand sa dernière date de présence connue a plus de 120 jours (soit
 * 90 à 120 jours après sa disparition, voir CONFIRM_EVERY_DAYS). Si elle réapparaît ensuite (offre republiée), elle
 * est annoncée de nouveau. (Un appel d'offres ne quitte la recherche qu'une fois sa date limite passée : il n'y revient pas.)
 */
export const SEEN_RETENTION_DAYS = 120
/**
 * La date retenue pour une annonce toujours en ligne n'est rafraîchie que si elle a plus de 30 jours : le fichier
 * d'état est versionné, le réécrire en entier chaque jour rendrait son historique illisible.
 */
const CONFIRM_EVERY_DAYS = 30

/** Une source qui avait au moins ce nombre d'annonces et n'en renvoie plus aucune est signalée. */
const EMPTY_ALERT_MIN = 5
/** Une source qui avait au moins ce nombre d'annonces et en perd plus de la moitié est signalée. */
const DROP_ALERT_MIN = 20
/**
 * Les organismes suivis publient plusieurs avis par semaine (environ 270 par an au BOAMP) : trois semaines sans aucun
 * avis signalent plutôt une requête devenue invalide (valeur d'API renommée) qu'une période creuse.
 */
const TENDER_EMPTY_ALERT_DAYS = 21

const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const sourceStateSchema = z.object({
  /** Identifiant d'annonce → dernier jour où sa présence a été notée (à 30 jours près, voir CONFIRM_EVERY_DAYS). */
  seen: z.record(z.string(), daySchema),
  /** Nombre d'annonces de référence, pour repérer une source qui se vide soudain (voir applyRun). */
  lastCount: z.number().int().nonnegative(),
  lastSuccessOn: daySchema,
  /** Dernier passage où la source a renvoyé au moins une annonce. */
  lastNonEmptyOn: daySchema.optional(),
})

export const veilleStateSchema = z.object({
  version: z.literal(1),
  sources: z.record(z.string(), sourceStateSchema),
  /** Procédures d'appel d'offres déjà annoncées (identifiant commun BOAMP / TED) → jour de la première annonce. */
  procedures: z.record(z.string(), daySchema),
  /**
   * Dernière version des réglages lue dans MyBestConsultant (ADR 0005), pour un passage où il ne répond pas. Son contenu
   * est revalidé au moment de servir (chooseSettings).
   */
  settings: z.object({ version: z.number().int().positive(), savedAt: z.string(), value: z.unknown() }).optional(),
})

export type SourceState = z.infer<typeof sourceStateSchema>
export type VeilleState = z.infer<typeof veilleStateSchema>

export const EMPTY_STATE: VeilleState = { version: 1, sources: {}, procedures: {} }

export type SourceOutcome = { sourceId: string; label: string; kind: ListingKind } & (
  | { ok: true; batch: SourceBatch }
  | { ok: false; error: string }
)

/** Nouvelle annonce, avec la source qui l'a donnée (pour lire son détail et, si elle n'est pas envoyée, l'oublier). */
export type NewListing = Listing & { sourceId: string }

export interface RunReport {
  newListings: NewListing[]
  failures: { label: string; error: string }[]
  /** Sources lues sans erreur mais dont le résultat est suspect (page modifiée, blocage…). */
  warnings: { label: string; message: string }[]
}

/** Offres d'emploi : la source donne toutes ses offres en ligne, un effondrement du nombre est suspect. */
function jobVolumeWarning(previousCount: number, count: number): string | null {
  if (count === 0 && previousCount >= EMPTY_ALERT_MIN) {
    return `Aucune annonce lue alors qu'il y en avait ${previousCount} auparavant : la page a peut-être changé ou bloque la lecture.`
  }
  if (previousCount >= DROP_ALERT_MIN && count < previousCount / 2) {
    return `${count} annonces lues contre ${previousCount} auparavant : vérifiez que la source n'a pas changé.`
  }
  return null
}

/** Appels d'offres : lus sur quelques jours, une semaine creuse est normale, trois semaines vides ne le sont pas. */
function tenderVolumeWarning(previous: SourceState, count: number, today: string): string | null {
  if (count > 0 || !previous.lastNonEmptyOn || previous.lastNonEmptyOn >= addDays(today, -TENDER_EMPTY_ALERT_DAYS)) return null
  return `Aucun avis depuis le ${frenchDay(previous.lastNonEmptyOn)} : la requête ou l'API a peut-être changé.`
}

export function applyRun(state: VeilleState, outcomes: SourceOutcome[], today: string): { report: RunReport; next: VeilleState } {
  const forgetBefore = addDays(today, -SEEN_RETENTION_DAYS)
  const confirmBefore = addDays(today, -CONFIRM_EVERY_DAYS)
  const report: RunReport = { newListings: [], failures: [], warnings: [] }
  const sources: Record<string, SourceState> = { ...state.sources }
  const procedures: Record<string, string> = {}
  for (const [id, day] of Object.entries(state.procedures)) {
    if (day >= forgetBefore) procedures[id] = day
  }

  for (const outcome of outcomes) {
    if (!outcome.ok) {
      report.failures.push({ label: outcome.label, error: outcome.error })
      continue
    }
    const previous = state.sources[outcome.sourceId]
    const currentIds = new Set([...outcome.batch.listings.map((l) => l.id), ...outcome.batch.ignoredIds])
    const warning = !previous
      ? null
      : outcome.kind === 'job'
        ? jobVolumeWarning(previous.lastCount, currentIds.size)
        : tenderVolumeWarning(previous, currentIds.size, today)

    const seen: Record<string, string> = {}
    for (const [id, day] of Object.entries(previous?.seen ?? {})) {
      // Lecture suspecte (source vidée) : rien n'est oublié, sinon tout serait réannoncé quand la source reviendra.
      if (warning || currentIds.has(id) || day >= forgetBefore) seen[id] = day
    }

    const announced = new Set<string>()
    for (const listing of outcome.batch.listings) {
      if (Object.hasOwn(seen, listing.id) || announced.has(listing.id)) continue
      announced.add(listing.id)
      const alreadyAnnounced = listing.procedureId !== undefined && Object.hasOwn(procedures, listing.procedureId)
      if (listing.procedureId) procedures[listing.procedureId] ??= today
      // Source lue pour la première fois comprise : toutes ses offres en ligne sont envoyées (décision du 22/10/2026).
      if (!alreadyAnnounced) report.newListings.push({ ...listing, sourceId: outcome.sourceId })
    }
    for (const id of currentIds) {
      const day = Object.hasOwn(seen, id) ? seen[id] : undefined
      if (day === undefined || day < confirmBefore) seen[id] = today
    }

    if (warning) report.warnings.push({ label: outcome.label, message: warning })
    for (const message of outcome.batch.warnings ?? []) report.warnings.push({ label: outcome.label, message })
    // Après une lecture suspecte, le nombre de référence est gardé : l'alerte revient chaque jour jusqu'à ce que la
    // source soit réparée. Une baisse réelle et durable s'accepte en corrigeant lastCount sur la branche veille-etat.
    const lastCount = warning && previous ? previous.lastCount : currentIds.size
    const lastNonEmptyOn = currentIds.size > 0 ? today : previous?.lastNonEmptyOn
    sources[outcome.sourceId] = { seen, lastCount, lastSuccessOn: today, ...(lastNonEmptyOn ? { lastNonEmptyOn } : {}) }
  }

  return { report, next: { version: 1, sources, procedures } }
}

/**
 * Ordre d'envoi des nouvelles annonces, qui compte quand le plafond par passage est atteint : appels d'offres
 * d'abord (délais de réponse), puis offres d'emploi ; par organisme dans l'ordre de la liste, les plus récentes d'abord.
 */
export function sendingOrder<T extends Listing>(listings: T[], organisations: readonly Organisation[] = ORGANISATIONS): T[] {
  const rank = (listing: Listing) => organisations.findIndex((o) => o.id === listing.organisationId)
  return [...listings].sort(
    (a, b) =>
      Number(a.kind === 'job') - Number(b.kind === 'job') ||
      rank(a) - rank(b) ||
      (b.publishedOn ?? '').localeCompare(a.publishedOn ?? ''),
  )
}

/**
 * État à retenir quand certaines nouvelles annonces n'ont pas pu être envoyées (plafond du passage, refus du serveur
 * d'envoi) : elles sont retirées des annonces vues, et redeviennent nouvelles au passage suivant. `previous` : l'état
 * lu en début de passage, pour ne retirer que ce que ce passage a ajouté.
 */
export function forgetUnsent(next: VeilleState, unsent: NewListing[], previous: VeilleState): VeilleState {
  const sources: Record<string, SourceState> = {}
  for (const [id, source] of Object.entries(next.sources)) sources[id] = { ...source, seen: { ...source.seen } }
  const procedures = { ...next.procedures }
  for (const listing of unsent) {
    const source = sources[listing.sourceId]
    if (source && !Object.hasOwn(previous.sources[listing.sourceId]?.seen ?? {}, listing.id)) delete source.seen[listing.id]
    // Une valeur différente de celle de l'état lu signifie que ce passage l'a posée (ou reposée après son oubli à
    // 120 jours) : elle est retirée, sinon l'offre non envoyée passerait le lendemain pour un doublon déjà annoncé.
    if (listing.procedureId && next.procedures[listing.procedureId] !== previous.procedures[listing.procedureId]) {
      delete procedures[listing.procedureId]
    }
  }
  return { ...next, sources, procedures }
}
