import { Inject, Injectable, Logger } from '@nestjs/common'
import { CLOCK, type Clock } from './clock.js'
import { APP_CONFIG, type AppConfig } from './config.js'
import { parisDay } from './dates.js'
import { renderDigest } from './digest/digest.js'
import type { ListingSource } from './listing.js'
import { Mailer } from './mail/mailer.js'
import { LISTING_SOURCES } from './sources/sources.js'
import { applyRun, type RunReport, type SourceOutcome, type VeilleState } from './state/run-state.js'
import { StateStore } from './state/state-store.js'

/** Un passage de la veille : lire les sources, repérer les nouveautés, envoyer le récapitulatif, retenir l'état. */
@Injectable()
export class ScanService {
  private readonly logger = new Logger(ScanService.name)

  constructor(
    @Inject(LISTING_SOURCES) private readonly sources: ListingSource[],
    private readonly store: StateStore,
    private readonly mailer: Mailer,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async run(): Promise<RunReport> {
    const state = await this.store.load()
    const outcomes: SourceOutcome[] = []
    // Une source après l'autre : quelques minutes au total, et jamais plusieurs requêtes simultanées vers un même site.
    for (const source of this.sources) outcomes.push(await this.read(source, state))

    const today = parisDay(this.clock.now())
    const { report, next } = applyRun(state, outcomes, today)
    const digest = renderDigest(report, today)
    this.logger.log(
      `${report.newListings.length} nouvelle(s) annonce(s), ${report.failures.length} source(s) en échec, ` +
        `${report.warnings.length} avertissement(s), ${report.initialised.length} source(s) initialisée(s).`,
    )

    if (this.config.dryRun) {
      this.logger.log(`Essai : rien n'est envoyé ni enregistré. Récapitulatif qui serait envoyé :\n\n${digest.subject}\n\n${digest.text}`)
      return report
    }
    // L'e-mail part avant l'enregistrement de l'état : si l'envoi échoue, les nouveautés seront annoncées au passage
    // suivant. Dans l'autre ordre, elles seraient marquées comme vues sans avoir été envoyées.
    await this.mailer.send(digest)
    this.logger.log(`Récapitulatif envoyé : « ${digest.subject} ».`)
    await this.store.save(next)
    return report
  }

  private async read(source: ListingSource, state: VeilleState): Promise<SourceOutcome> {
    const known = state.sources[source.id]
    const started = Date.now()
    try {
      const batch = await source.fetch({ firstRun: !known, isKnown: (id) => known !== undefined && Object.hasOwn(known.seen, id) })
      this.logger.log(`${source.label} : ${batch.listings.length} annonce(s) retenue(s), ${batch.ignoredIds.length} hors périmètre (${Date.now() - started} ms).`)
      return { sourceId: source.id, label: source.label, kind: source.kind, ok: true, batch }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(`${source.label} : lecture impossible — ${message}`, error instanceof Error ? error.stack : undefined)
      return { sourceId: source.id, label: source.label, kind: source.kind, ok: false, error: message }
    }
  }
}
