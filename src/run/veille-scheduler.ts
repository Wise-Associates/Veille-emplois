// Passages planifiés de la veille sur le VPS (ADR 0010), dans le conteneur qui tourne en permanence
// (`node dist/main.js --schedule`). Mêmes heures que l'ancien workflow GitHub : 5 h, 9 h, 13 h et 17 h UTC (6 h ou 7 h à
// Paris pour le premier). Plusieurs petits passages font partir plus d'offres qu'un seul gros : les serveurs d'envoi
// limitent les messages par heure (IONOS : 50 à 500 selon l'âge de la boîte), MAX_OFFER_EMAILS_PER_RUN sous la limite.

import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common'
import { Cron, SchedulerRegistry } from '@nestjs/schedule'
import type { DigestMode } from '../config.js'
import { frenchDeadline } from '../dates.js'
import { StateStore } from '../state/state-store.js'
import { VeilleRunner } from './veille-runner.js'

/** Passage du matin : il envoie toujours le récapitulatif, son arrivée prouve que la veille tourne. */
export const MORNING_RUN = '0 5 * * *'
/** Passages de la journée : récapitulatif seulement s'il y a un point à vérifier. */
export const DAY_RUNS = '0 9,13,17 * * *'
const MORNING_JOB = 'veille-matin'
const DAY_JOB = 'veille-journee'
/** Écrit une fois la planification en place : la sonde de santé du conteneur (deploy/compose.yml) le vérifie. */
export const READY_FILE = join(tmpdir(), 'veille-planifiee')

@Injectable()
export class VeilleScheduler implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(VeilleScheduler.name)
  private current: Promise<unknown> | null = null
  private stopping = false

  constructor(
    private readonly runner: VeilleRunner,
    private readonly registry: SchedulerRegistry,
    private readonly store: StateStore,
  ) {}

  // Heures UTC fixes, indépendantes du fuseau du serveur et du conteneur.
  @Cron(MORNING_RUN, { name: MORNING_JOB, timeZone: 'UTC' })
  async morning(): Promise<void> {
    await this.start('always')
  }

  @Cron(DAY_RUNS, { name: DAY_JOB, timeZone: 'UTC' })
  async daytime(): Promise<void> {
    await this.start('problems')
  }

  /**
   * Un passage à la fois : si le précédent n'est pas fini (lecture de la boîte AO lente), celui-ci est sauté ; ses offres
   * partent au suivant. Un passage lancé à la main en même temps est arrêté par le verrou du fichier d'état.
   */
  async start(digestMode: DigestMode): Promise<void> {
    if (this.stopping) return
    if (this.current) {
      this.logger.warn('Le passage précédent n\'est pas terminé : ce passage planifié est sauté.')
      return
    }
    const run = this.runner.run({ digestMode, shouldStop: () => this.stopping })
    this.current = run
    try {
      this.logger.log(`Passage planifié terminé : ${await run}.`)
    } finally {
      this.current = null
    }
  }

  /**
   * Démarrage du conteneur : un verrou encore là vient d'un passage tué net (aucun passage ne survit à un redémarrage du
   * conteneur) ; il est retiré, sinon les passages des deux heures suivantes seraient refusés en silence, récapitulatif
   * du matin compris. L'équipe est prévenue une fois la planification en place.
   */
  async onApplicationBootstrap(): Promise<void> {
    const leftover = await this.store.clearLeftoverLock()
    const next = (job: string) => this.registry.getCronJob(job).nextDate().toUTC().toFormat("dd/LL/yyyy HH:mm 'UTC'")
    this.logger.log(
      `Veille planifiée : passages à 5 h (récapitulatif toujours envoyé), 9 h, 13 h et 17 h UTC. ` +
        `Prochains : ${next(MORNING_JOB)} (matin), ${next(DAY_JOB)} (journée).`,
    )
    await writeFile(READY_FILE, new Date().toISOString())
    if (leftover !== undefined) {
      this.logger.warn(`Verrou d'un passage interrompu retiré (${leftover ? `posé le ${frenchDeadline(leftover.toISOString())}` : 'illisible'}).`)
      await this.runner.reportInterruptedRun(leftover)
    }
  }

  /**
   * Arrêt du conteneur (déploiement, redémarrage) : plus aucun passage n'est lancé, et celui en cours va au bout. Sans
   * cela, ses offres déjà envoyées ne seraient pas retenues et repartiraient. compose.yml laisse le temps nécessaire.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true
    if (!this.current) return
    this.logger.log('Arrêt demandé : fin du passage en cours attendue avant de s\'arrêter.')
    await this.current
  }
}
