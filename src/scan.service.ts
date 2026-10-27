import { Inject, Injectable, Logger } from '@nestjs/common'
import { CLOCK, type Clock } from './clock.js'
import { APP_CONFIG, type AppConfig } from './config.js'
import { parisDay } from './dates.js'
import { needsAttention, renderDigest, type DeliverySummary } from './digest/digest.js'
import { renderOfferEmail } from './digest/offer-email.js'
import { itRulesFrom, scopeToIt, type ItRules } from './it-scope.js'
import type { Listing, ListingDetails, ListingSource } from './listing.js'
import { isMessageRejection, Mailer } from './mail/mailer.js'
import { organisationsFrom, type Organisation } from './organisations.js'
import { SettingsLoader } from './settings/settings-loader.js'
import { SOURCE_FACTORY, type SourceFactory } from './sources/sources.js'
import {
  applyRun,
  forgetUnsent,
  sendingOrder,
  type NewListing,
  type RunReport,
  type SourceOutcome,
  type VeilleState,
} from './state/run-state.js'
import { StateStore } from './state/state-store.js'

/**
 * Passage terminé avec l'état enregistré, mais un envoi a échoué (offres ou récapitulatif) : le workflow doit
 * quand même pousser l'état (les offres envoyées ne doivent pas repartir), puis signaler l'échec (code de sortie 3).
 */
export class PartialDeliveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PartialDeliveryError'
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Ce qu'un passage tire de ses réglages, pour l'envoi et l'essai. */
interface RunContext {
  sources: ListingSource[]
  organisations: readonly Organisation[]
  settingsWarnings: { label: string; message: string }[]
}

/**
 * Durée au-delà de laquelle plus aucune offre n'est commencée. Le job GitHub est tué à 40 minutes (installation et
 * compilation comprises) ; 25 minutes laissent la marge d'enregistrer l'état et d'envoyer le récapitulatif.
 */
export const RUN_TIME_BUDGET_MS = 25 * 60_000
const MAX_CONSECUTIVE_PAGE_FAILURES = 3

/**
 * Un passage de la veille : lire les sources, envoyer chaque nouvelle offre dans son propre e-mail à la boîte AO,
 * retenir ce qui a été envoyé, puis envoyer le récapitulatif à l'équipe.
 */
@Injectable()
export class ScanService {
  private readonly logger = new Logger(ScanService.name)

  constructor(
    @Inject(SOURCE_FACTORY) private readonly createSources: SourceFactory,
    private readonly settingsLoader: SettingsLoader,
    private readonly store: StateStore,
    private readonly mailer: Mailer,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async run(): Promise<DeliverySummary> {
    const startedAt = this.clock.now().getTime()
    const state = await this.store.load()
    // Réglages du passage (MyBestConsultant, sinon dernière version connue, sinon ceux du dépôt) : organismes suivis,
    // sources lues, périmètre informatique.
    const chosen = await this.settingsLoader.load(state.settings)
    const organisations = organisationsFrom(chosen.settings)
    const sources = this.createSources(chosen.settings, organisations)
    const itRules = itRulesFrom(chosen.settings.itScope)
    const settingsWarnings = chosen.warning ? [{ label: 'Réglages de la veille', message: chosen.warning }] : []
    const outcomes: SourceOutcome[] = []
    // Une source après l'autre : quelques minutes au total, et jamais plusieurs requêtes simultanées vers un même site.
    let outOfScope = 0
    for (const source of sources) {
      const read = await this.read(source, state, itRules)
      outcomes.push(read.outcome)
      outOfScope += read.outOfScopeNew
    }

    const today = parisDay(this.clock.now())
    const { report, next } = applyRun(state, outcomes, today)
    const batch = sendingOrder(report.newListings, organisations).slice(0, this.config.maxOfferEmailsPerRun)
    this.logger.log(
      `${report.newListings.length} nouvelle(s) annonce(s), ${batch.length} à envoyer dans ce passage ; ` +
        `${report.failures.length} source(s) en échec, ${report.warnings.length} avertissement(s).`,
    )

    const run: RunContext = { sources, organisations, settingsWarnings }
    if (this.config.dryRun) return this.preview(batch, report, today, outOfScope, run)

    const details = new DetailReader()
    const sent: NewListing[] = []
    const refused: string[] = []
    const outdated: NewListing[] = []
    let deliveryError: string | null = null
    for (const listing of batch) {
      // Au-delà du budget de temps, le reste attend le passage suivant (comme au-delà du plafond) : un passage tué par
      // le délai maximal du workflow n'enregistrerait rien, et renverrait le lendemain les offres déjà envoyées.
      if (this.clock.now().getTime() - startedAt >= RUN_TIME_BUDGET_MS) {
        this.logger.warn(`Budget de temps atteint après ${sent.length} offre(s) : le reste partira au passage suivant.`)
        break
      }
      const complete = await this.complete(listing, details, sources)
      // Date limite déjà passée (souvent connue seulement par la page de l'offre) : rien à envoyer. L'offre est
      // retenue comme traitée, pour ne pas relire sa page à chaque passage.
      if (complete.deadline && complete.deadline.slice(0, 10) < today) {
        outdated.push(listing)
        continue
      }
      try {
        await this.mailer.sendOffer(renderOfferEmail(complete, organisations))
      } catch (error) {
        if (isMessageRejection(error)) {
          // Refus propre à ce message : les suivants partent quand même ; celui-ci sera retenté au passage suivant.
          refused.push(`« ${listing.title.slice(0, 80)} » (${listing.organisationId}, ${listing.id}) : ${message(error)}`)
          this.logger.error(`Offre ${listing.id} refusée par le serveur d'envoi : ${message(error)}`)
          continue
        }
        // Le serveur d'envoi refuse tout (adresse, identifiants, quota…) : inutile d'insister.
        deliveryError = message(error)
        this.logger.error(`Envoi des offres interrompu après ${sent.length} : ${deliveryError}`, error instanceof Error ? error.stack : undefined)
        break
      }
      sent.push(listing)
    }

    // L'état ne retient que les offres traitées (envoyées, ou écartées car échues) : les autres redeviennent nouvelles
    // au passage suivant.
    const handled = new Set([...sent, ...outdated])
    const unsent = report.newListings.filter((listing) => !handled.has(listing))
    // La version des réglages lue dans MyBestConsultant est gardée pour un passage où il ne répondrait pas.
    await this.store.save(forgetUnsent({ ...next, settings: chosen.snapshot }, unsent, state))
    this.logger.log(
      `${sent.length} offre(s) envoyée(s) à la boîte AO, ${outdated.length} échue(s) écartée(s), ${unsent.length} en attente ; état enregistré.`,
    )

    const summary: DeliverySummary = {
      sent,
      outdated: outdated.length,
      outOfScope,
      pending: unsent.length,
      perRunLimit: this.config.maxOfferEmailsPerRun,
      timeBudgetMinutes: RUN_TIME_BUDGET_MS / 60_000,
      deliveryError,
      failures: report.failures,
      warnings: [
        ...settingsWarnings,
        ...report.warnings,
        ...details.warnings(),
        ...refused.map((offer) => ({ label: "Boîte AO (serveur d'envoi)", message: `Offre refusée, retentée au prochain passage : ${offer}` })),
      ],
    }
    const digest = renderDigest(summary, today, organisations)
    let digestError: string | null = null
    // Passages de la journée (DIGEST_MODE=problems) : récapitulatif seulement s'il y a un point à vérifier ; celui du
    // matin l'envoie toujours, son arrivée prouve que la veille tourne.
    if (this.config.digestMode === 'problems' && !needsAttention(summary)) {
      this.logger.log(`Récapitulatif non envoyé (DIGEST_MODE=problems, aucun point à vérifier) : « ${digest.subject} ».`)
    } else {
      try {
        await this.mailer.sendDigest(digest)
        this.logger.log(`Récapitulatif envoyé : « ${digest.subject} ».`)
      } catch (error) {
        digestError = message(error)
      }
    }
    if (deliveryError || refused.length || digestError) {
      throw new PartialDeliveryError(
        [
          deliveryError && `envoi des offres interrompu (${deliveryError})`,
          refused.length && `${refused.length} offre(s) refusée(s) par le serveur d'envoi`,
          digestError && `récapitulatif non envoyé (${digestError})`,
        ]
          .filter(Boolean)
          .join(' ; '),
      )
    }
    return summary
  }

  /** Essai : affiche le récapitulatif et le premier e-mail d'offre, complété comme il le serait ; rien n'est envoyé. */
  private async preview(batch: NewListing[], report: RunReport, today: string, outOfScope: number, run: RunContext): Promise<DeliverySummary> {
    const summary: DeliverySummary = {
      sent: batch,
      outdated: 0,
      outOfScope,
      pending: report.newListings.length - batch.length,
      perRunLimit: this.config.maxOfferEmailsPerRun,
      timeBudgetMinutes: RUN_TIME_BUDGET_MS / 60_000,
      deliveryError: null,
      failures: report.failures,
      warnings: [...run.settingsWarnings, ...report.warnings],
    }
    const digest = renderDigest(summary, today, run.organisations)
    const first = batch[0] ? renderOfferEmail(await this.complete(batch[0], new DetailReader(), run.sources), run.organisations) : null
    this.logger.log(
      `Essai : rien n'est envoyé ni enregistré.\n\n=== Récapitulatif (équipe) ===\n${digest.subject}\n\n${digest.text}` +
        (first ? `\n\n=== Premier des ${batch.length} e-mails d'offre (boîte AO) ===\n${first.subject}\n\n${first.text}` : ''),
    )
    return summary
  }

  /** Offre complétée par la page de l'offre, si sa source en a besoin. Un échec n'empêche pas l'envoi, il est signalé. */
  private async complete(listing: NewListing, details: DetailReader, sources: readonly ListingSource[]): Promise<Listing> {
    const source = sources.find((s) => s.id === listing.sourceId)
    if (!source?.describe) return listing
    if (details.abandoned(source.label)) {
      details.failed(source.label)
      return listing
    }
    try {
      const found: ListingDetails = await source.describe(listing)
      details.succeeded(source.label)
      const defined = Object.fromEntries(Object.entries(found).filter(([, value]) => value !== undefined && value !== ''))
      return { ...listing, ...defined }
    } catch (error) {
      this.logger.warn(`${source.label} : détail de l'offre ${listing.id} illisible — ${message(error)}`)
      details.failed(source.label)
      return listing
    }
  }

  /**
   * Lecture d'une source, réduite au périmètre informatique des réglages (it-scope.ts). `outOfScopeNew` : offres
   * jamais vues écartées par ce périmètre, comptées dans le récapitulatif.
   */
  private async read(source: ListingSource, state: VeilleState, itRules: ItRules): Promise<{ outcome: SourceOutcome; outOfScopeNew: number }> {
    const known = state.sources[source.id]
    const isKnown = (id: string) => known !== undefined && Object.hasOwn(known.seen, id)
    const started = Date.now()
    try {
      const { batch, outOfScope } = scopeToIt(await source.fetch({ isKnown }), itRules)
      this.logger.log(
        `${source.label} : ${batch.listings.length} annonce(s) informatique(s), ${outOfScope.length} hors informatique, ` +
          `${batch.ignoredIds.length - outOfScope.length} hors organismes suivis (${Date.now() - started} ms).`,
      )
      return {
        outcome: { sourceId: source.id, label: source.label, kind: source.kind, ok: true, batch },
        outOfScopeNew: outOfScope.filter((id) => !isKnown(id)).length,
      }
    } catch (error) {
      this.logger.error(`${source.label} : lecture impossible — ${message(error)}`, error instanceof Error ? error.stack : undefined)
      return { outcome: { sourceId: source.id, label: source.label, kind: source.kind, ok: false, error: message(error) }, outOfScopeNew: 0 }
    }
  }
}

/**
 * Suivi des lectures de pages d'offres pendant l'envoi, par source. Après quelques échecs de suite (site en panne ou
 * page modifiée), la source n'est plus lue pendant ce passage : ses offres partent sans le détail, sans attendre
 * chaque fois la fin du délai.
 */
class DetailReader {
  private readonly bySource = new Map<string, { failed: number; consecutive: number }>()

  abandoned(label: string): boolean {
    return (this.bySource.get(label)?.consecutive ?? 0) >= MAX_CONSECUTIVE_PAGE_FAILURES
  }

  succeeded(label: string): void {
    const entry = this.bySource.get(label)
    if (entry) entry.consecutive = 0
  }

  failed(label: string): void {
    const entry = this.bySource.get(label) ?? { failed: 0, consecutive: 0 }
    entry.failed++
    entry.consecutive++
    this.bySource.set(label, entry)
  }

  warnings(): { label: string; message: string }[] {
    return [...this.bySource]
      .filter(([, entry]) => entry.failed > 0)
      .map(([label, entry]) => ({
        label,
        message:
          `${entry.failed} offre(s) envoyée(s) sans le détail de leur page (lecture impossible` +
          `${entry.consecutive >= MAX_CONSECUTIVE_PAGE_FAILURES ? `, abandonnée après ${MAX_CONSECUTIVE_PAGE_FAILURES} échecs de suite` : ''}) : ` +
          'la page a peut-être changé.',
      }))
  }
}
