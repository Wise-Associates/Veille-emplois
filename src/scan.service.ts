import { Inject, Injectable, Logger } from '@nestjs/common'
import { CLOCK, type Clock } from './clock.js'
import { APP_CONFIG, type AppConfig, type DigestMode } from './config.js'
import { parisDay } from './dates.js'
import { needsAttention, renderDigest, type DeliverySummary } from './digest/digest.js'
import type { EmailAttachment, RenderedEmail } from './digest/format.js'
import { renderOfferEmail } from './digest/offer-email.js'
import { itRulesFrom, scopeToIt, type ItRules } from './it-scope.js'
import { isSiteUnavailable } from './http/http-client.js'
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
import { NoticePdfReader } from './tenders/notice-pdf.js'

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
    private readonly noticePdfs: NoticePdfReader,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * `digestMode` : celui du passage planifié (le passage de 5 h envoie toujours le récapitulatif, veille-scheduler.ts) ;
   * à défaut, celui de la configuration (DIGEST_MODE).
   */
  async run(options: { digestMode?: DigestMode } = {}): Promise<DeliverySummary> {
    const digestMode = options.digestMode ?? this.config.digestMode
    const startedAt = this.clock.now().getTime()
    const state = await this.store.load()
    // Réglages du passage (MyBestConsultant, sinon dernière version connue, sinon ceux du dépôt) : organismes suivis,
    // sources lues, périmètre informatique.
    const chosen = await this.settingsLoader.load(state.settings)
    const organisations = organisationsFrom(chosen.settings)
    const sources = this.createSources(chosen.settings, organisations)
    const itRules = itRulesFrom(chosen.settings)
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

    const details = new DetailReader(PAGE_FAILURES)
    const pdfs = new DetailReader(PDF_FAILURES)
    const sent: NewListing[] = []
    const refused: string[] = []
    const sentWithoutPdf: string[] = []
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
      // Avis officiel en PDF, téléchargé seulement pour une offre qui part (pas pour une offre échue).
      const attachments = await this.attachNoticePdf(listing, pdfs, sources)
      try {
        try {
          await this.mailer.sendOffer(renderOfferEmail(complete, organisations, attachments))
        } catch (error) {
          // Message refusé pour lui-même alors qu'il portait l'avis PDF (taille, filtre du serveur) : renvoyé aussitôt
          // sans lui, sinon l'offre repartirait chaque passage avec le même PDF et serait refusée chaque fois.
          if (!attachments.length || !isMessageRejection(error)) throw error
          this.logger.warn(`Offre ${listing.id} refusée avec son avis PDF, renvoyée sans lui : ${message(error)}`)
          await this.mailer.sendOffer(renderOfferEmail(complete, organisations))
          sentWithoutPdf.push(`« ${listing.title.slice(0, 80)} » (${listing.organisationId}, ${listing.id}) : ${message(error)}`)
        }
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
    const saved = await this.store.save(forgetUnsent({ ...next, settings: chosen.snapshot }, unsent, state))
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
        ...(saved.warning ? [{ label: "Fichier d'état", message: saved.warning }] : []),
        ...report.warnings,
        ...details.warnings(),
        ...pdfs.warnings(),
        ...sentWithoutPdf.map((offer) => ({ label: "Boîte AO (serveur d'envoi)", message: `Avis PDF refusé avec le message, offre envoyée sans lui : ${offer}` })),
        ...refused.map((offer) => ({ label: "Boîte AO (serveur d'envoi)", message: `Offre refusée, retentée au prochain passage : ${offer}` })),
      ],
    }
    const digest = renderDigest(summary, today, organisations)
    let digestError: string | null = null
    // Passages de la journée (DIGEST_MODE=problems) : récapitulatif seulement s'il y a un point à vérifier ; celui du
    // matin l'envoie toujours, son arrivée prouve que la veille tourne.
    if (digestMode === 'problems' && !needsAttention(summary)) {
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
    let first: RenderedEmail | null = null
    if (batch[0]) {
      const complete = await this.complete(batch[0], new DetailReader(PAGE_FAILURES), run.sources)
      // Comme dans un vrai passage, pas de téléchargement pour une offre échue (elle ne partirait pas).
      const outdated = complete.deadline !== undefined && complete.deadline.slice(0, 10) < today
      const attachments = outdated ? [] : await this.attachNoticePdf(batch[0], new DetailReader(PDF_FAILURES), run.sources)
      first = renderOfferEmail(complete, run.organisations, attachments)
    }
    // Pièces jointes : nom et taille seulement (le contenu d'un avis nomme le contact de l'acheteur).
    const attached = first?.attachments?.map((a) => `${a.filename} (${Math.ceil(a.content.byteLength / 1024)} Ko)`).join(', ')
    this.logger.log(
      `Essai : rien n'est envoyé ni enregistré.\n\n=== Récapitulatif (équipe) ===\n${digest.subject}\n\n${digest.text}` +
        (first
          ? `\n\n=== Premier des ${batch.length} e-mails d'offre (boîte AO) ===\n${first.subject}\n` +
            `Pièce(s) jointe(s) : ${attached ?? 'aucune'}\n\n${first.text}`
          : ''),
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
   * Avis officiel en PDF de l'offre, si sa source en donne l'adresse (BOAMP, TED). Un échec n'empêche pas l'envoi : l'offre
   * part sans lui (son e-mail garde le lien de l'avis), et c'est signalé dans le récapitulatif.
   */
  private async attachNoticePdf(listing: NewListing, pdfs: DetailReader, sources: readonly ListingSource[]): Promise<EmailAttachment[]> {
    if (!listing.noticePdfUrl) return []
    const label = sources.find((s) => s.id === listing.sourceId)?.label ?? listing.sourceId
    if (pdfs.abandoned(label)) {
      pdfs.failed(label)
      return []
    }
    try {
      const pdf = await this.noticePdfs.read(listing.noticePdfUrl, listing.id)
      pdfs.succeeded(label)
      return [pdf]
    } catch (error) {
      this.logger.warn(`${label} : avis PDF de l'offre ${listing.id} non joint — ${message(error)}`)
      // Un avis introuvable (404) ou un fichier refusé ne concerne que cet avis : seul un site injoignable ou en panne
      // fait cesser les téléchargements de la source pour ce passage.
      pdfs.failed(label, isSiteUnavailable(error))
      return []
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

/** Message du récapitulatif pour les offres d'une source envoyées sans un complément (`abandoned` : lecture arrêtée). */
type FailureMessage = (failed: number, abandoned: boolean) => string

const PAGE_FAILURES: FailureMessage = (failed, abandoned) =>
  `${failed} offre(s) envoyée(s) sans le détail de leur page (lecture impossible` +
  `${abandoned ? `, abandonnée après ${MAX_CONSECUTIVE_PAGE_FAILURES} échecs de suite` : ''}) : la page a peut-être changé.`

const PDF_FAILURES: FailureMessage = (failed, abandoned) =>
  `${failed} offre(s) envoyée(s) sans l'avis officiel en PDF (téléchargement impossible` +
  `${abandoned ? `, abandonné après ${MAX_CONSECUTIVE_PAGE_FAILURES} échecs de suite` : ''}) : l'adresse des avis a peut-être ` +
  `changé ; le lien de l'avis officiel figure dans chaque e-mail.`

/**
 * Suivi des lectures faites pendant l'envoi (pages d'offres, avis PDF), par source. Après quelques échecs de suite (site
 * en panne ou modifié), la source n'est plus lue pendant ce passage : ses offres partent sans ce complément, sans
 * attendre chaque fois la fin du délai.
 */
class DetailReader {
  private readonly bySource = new Map<string, { failed: number; consecutive: number }>()

  constructor(private readonly failureMessage: FailureMessage) {}

  abandoned(label: string): boolean {
    return (this.bySource.get(label)?.consecutive ?? 0) >= MAX_CONSECUTIVE_PAGE_FAILURES
  }

  succeeded(label: string): void {
    const entry = this.bySource.get(label)
    if (entry) entry.consecutive = 0
  }

  /** `siteUnavailable` : faux pour un échec propre à une offre (le site a répondu), qui ne rapproche pas de l'abandon. */
  failed(label: string, siteUnavailable = true): void {
    const entry = this.bySource.get(label) ?? { failed: 0, consecutive: 0 }
    entry.failed++
    entry.consecutive = siteUnavailable ? entry.consecutive + 1 : 0
    this.bySource.set(label, entry)
  }

  warnings(): { label: string; message: string }[] {
    return [...this.bySource]
      .filter(([, entry]) => entry.failed > 0)
      .map(([label, entry]) => ({ label, message: this.failureMessage(entry.failed, entry.consecutive >= MAX_CONSECUTIVE_PAGE_FAILURES) }))
  }
}
