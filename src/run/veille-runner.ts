// Déroulé d'un passage, le même qu'il soit planifié (veille-scheduler.ts) ou lancé à la main (main.ts) : verrou, passage,
// lecture de la boîte AO par MyBestConsultant, alerte de l'équipe en cas d'échec. Ne lève jamais d'erreur : le résultat
// dit ce qui s'est passé, et chaque problème est journalisé.

import { Inject, Injectable, Logger } from '@nestjs/common'
import { CLOCK, type Clock } from '../clock.js'
import { APP_CONFIG, type AppConfig, type DigestMode } from '../config.js'
import { renderRunAlert } from '../digest/alert-email.js'
import { Mailer } from '../mail/mailer.js'
import { PartialDeliveryError, ScanService } from '../scan.service.js'
import { RunInProgressError, StateStore } from '../state/state-store.js'
import { AoInboxSync } from './ao-inbox-sync.js'

/**
 * `complete` : tout s'est bien passé ; `partial` : état enregistré, mais un envoi ou la lecture de la boîte AO a échoué ;
 * `failed` : passage interrompu avant l'enregistrement de l'état ; `busy` : un autre passage tenait le verrou, rien n'a
 * été fait.
 */
export type RunOutcome = 'complete' | 'partial' | 'failed' | 'busy'

/** Codes de sortie d'un passage lancé par `node dist/main.js` (lus par l'ancien workflow GitHub) : 3 = état enregistré. */
export const EXIT_CODES: Record<RunOutcome, number> = { complete: 0, partial: 3, failed: 1, busy: 1 }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const stack = (error: unknown) => (error instanceof Error ? error.stack : undefined)

@Injectable()
export class VeilleRunner {
  private readonly logger = new Logger(VeilleRunner.name)

  constructor(
    private readonly scan: ScanService,
    private readonly store: StateStore,
    private readonly aoInbox: AoInboxSync,
    private readonly mailer: Mailer,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** `shouldStop` : arrêt du conteneur demandé ; la lecture de la boîte AO ne fait plus de nouvel appel. */
  async run(options: { digestMode?: DigestMode; shouldStop?: () => boolean } = {}): Promise<RunOutcome> {
    try {
      if (this.config.dryRun) return await this.dryRun(options.digestMode)
      return await this.realRun(options)
    } finally {
      this.mailer.close()
    }
  }

  /** Essai : rien n'est envoyé ni enregistré, donc ni verrou, ni boîte AO, ni alerte. */
  private async dryRun(digestMode: DigestMode | undefined): Promise<RunOutcome> {
    try {
      await this.scan.run({ digestMode })
      return 'complete'
    } catch (error) {
      this.logger.error(`Essai interrompu : ${message(error)}`, stack(error))
      return 'failed'
    }
  }

  private async realRun(options: { digestMode?: DigestMode; shouldStop?: () => boolean }): Promise<RunOutcome> {
    const startedAt = this.clock.now()
    const problems: string[] = []
    const problem = (text: string, error: unknown) => {
      problems.push(`${text} : ${message(error)}`)
      this.logger.error(`${text} : ${message(error)}`, stack(error))
    }

    let release: () => Promise<void>
    try {
      release = await this.store.acquireRunLock()
    } catch (error) {
      if (error instanceof RunInProgressError) {
        this.logger.warn(error.message)
        return 'busy'
      }
      problem('Passage non lancé, verrou du fichier d\'état impossible à poser', error)
      await this.alert(startedAt, problems, false)
      return 'failed'
    }

    let outcome: RunOutcome = 'complete'
    try {
      try {
        await this.scan.run({ digestMode: options.digestMode })
      } catch (error) {
        if (error instanceof PartialDeliveryError) {
          outcome = 'partial'
          problem('Passage terminé, état enregistré, mais envoi incomplet', error)
        } else {
          outcome = 'failed'
          problem('Passage interrompu, état non enregistré', error)
        }
      }
      // Après un envoi incomplet aussi : des offres sont parties.
      if (outcome !== 'failed') {
        try {
          this.logSync(await this.aoInbox.run(options.shouldStop))
        } catch (error) {
          outcome = 'partial'
          problem('Lecture de la boîte AO par MyBestConsultant impossible', error)
        }
      }
    } finally {
      // Un verrou resté en place bloquerait les passages des deux heures suivantes : signalé comme un échec.
      await release().catch((error: unknown) => problem('Verrou du fichier d\'état non retiré (passages refusés pendant deux heures)', error))
    }
    if (problems.length) await this.alert(startedAt, problems, outcome !== 'failed')
    if (problems.length && outcome === 'complete') outcome = 'partial'
    return outcome
  }

  /**
   * Passage interrompu par un arrêt brutal du conteneur (panne, mémoire, redémarrage du serveur), découvert au
   * redémarrage par son verrou resté en place (VeilleScheduler) : l'équipe est prévenue, ses offres déjà envoyées
   * repartiront au passage suivant. `since` : début du passage, null s'il est inconnu.
   */
  async reportInterruptedRun(since: Date | null): Promise<void> {
    const problem = "Passage interrompu par un arrêt brutal du conteneur (panne, manque de mémoire, redémarrage du serveur) : son verrou a été retiré au redémarrage."
    this.logger.error(problem)
    try {
      await this.alert(since ?? this.clock.now(), [problem], false)
    } finally {
      this.mailer.close()
    }
  }

  private logSync(report: Awaited<ReturnType<AoInboxSync['run']>>): void {
    if (!report) {
      this.logger.log('AO_SYNC_URL non défini : la boîte AO sera lue par le prochain passage planifié de MyBestConsultant.')
      return
    }
    const counts = `${report.processed} e-mail(s) traité(s), ${report.offersCreated} offre(s) créée(s), ${report.remaining} en attente`
    if (report.outcome === 'ai-unavailable') {
      this.logger.warn(`MyBestConsultant : IA indisponible (crédits ou clé, voir Config IA) — ${counts}.`)
    } else {
      this.logger.log(`MyBestConsultant a lu la boîte AO (${report.calls} appel(s)) : ${counts}.`)
    }
  }

  /** Alerte de l'équipe ; si elle ne part pas non plus (serveur d'envoi en panne), seul le journal le dit. */
  private async alert(startedAt: Date, problems: string[], stateSaved: boolean): Promise<void> {
    try {
      await this.mailer.sendAlert(renderRunAlert({ startedAt, problems, stateSaved }))
      this.logger.log("Alerte d'échec envoyée à l'équipe (MAIL_TO).")
    } catch (error) {
      this.logger.error(`Alerte d'échec non envoyée : ${message(error)}`, stack(error))
    }
  }
}
