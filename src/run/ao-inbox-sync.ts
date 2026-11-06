// Lecture de la boîte AO par MyBestConsultant juste après l'envoi des offres (ADR 0008) : sans elle, les offres
// envoyées n'apparaissent qu'au passage planifié de MyBestConsultant. Sur le VPS, l'application fait elle-même ce que
// faisait le job « synchroniser » du workflow GitHub (ADR 0010).

import { Inject, Injectable } from '@nestjs/common'
import { z } from 'zod'
import { CLOCK, type Clock } from '../clock.js'
import { APP_CONFIG, type AppConfig } from '../config.js'
import { HttpClient } from '../http/http-client.js'

/** Attente injectée : les tests ne patientent pas pour de vrai. */
export const SLEEP = Symbol('SLEEP')
export type Sleep = (ms: number) => Promise<void>

/** Laisse aux derniers e-mails acceptés par le serveur d'envoi le temps d'arriver dans la boîte. */
const DELIVERY_DELAY_MS = 30_000
/** Un appel lit au plus 25 e-mails en 4 minutes ; la route de MyBestConsultant s'arrête à 5. */
const CALL_TIMEOUT_MS = 320_000
/** Rappels tant qu'il reste des e-mails, pendant 15 minutes au plus ; le reste est lu au passage suivant. */
const SYNC_BUDGET_MS = 15 * 60_000
/** Une autre lecture de la boîte est en cours (bouton « Synchroniser », passage planifié de MyBestConsultant). */
const BUSY_RETRY_MS = 30_000

/** Compte rendu de syncAoInbox (MyBestConsultant, src/lib/ao/sync.ts) : seuls les nombres sont lus, jamais les erreurs. */
const reportSchema = z.object({
  processed: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  offersCreated: z.number().int().nonnegative().default(0),
  skipped: z.boolean().default(false),
  aiUnavailable: z.boolean().default(false),
})

export interface SyncReport {
  calls: number
  processed: number
  offersCreated: number
  remaining: number
  /**
   * `done` : tout est lu ; `no-progress` : rien n'a avancé (e-mails en erreur) ; `ai-unavailable` : l'IA de
   * MyBestConsultant refuse (crédits, clé), les e-mails attendent ; `time-limit` : 15 minutes atteintes ; `stopped` :
   * le conteneur s'arrête.
   */
  outcome: 'done' | 'no-progress' | 'ai-unavailable' | 'time-limit' | 'stopped'
}

@Injectable()
export class AoInboxSync {
  constructor(
    private readonly http: HttpClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SLEEP) private readonly sleep: Sleep,
  ) {}

  /**
   * Fait lire la boîte AO par MyBestConsultant ; null si la route n'est pas configurée (AO_SYNC_URL). Lève une erreur
   * si MyBestConsultant refuse ou ne répond pas (le message ne contient jamais le secret). `shouldStop` : plus aucun
   * nouvel appel une fois vrai.
   */
  async run(shouldStop: () => boolean = () => false): Promise<SyncReport | null> {
    const target = this.config.aoSync
    if (!target) return null
    const origin = new URL(target.url).origin
    await this.sleep(DELIVERY_DELAY_MS)
    const start = this.clock.now().getTime()
    const elapsed = () => this.clock.now().getTime() - start
    const report = { calls: 0, processed: 0, offersCreated: 0, remaining: 0 }
    // Un appel n'est commencé que s'il peut finir dans les 15 minutes.
    while (SYNC_BUDGET_MS - elapsed() >= CALL_TIMEOUT_MS + 10_000) {
      if (shouldStop()) return { ...report, outcome: 'stopped' }
      const reply = await this.http.json(target.url, reportSchema, {
        headers: { Authorization: `Bearer ${target.token}` },
        timeoutMs: CALL_TIMEOUT_MS,
        retry: false,
        // Le secret n'est renvoyé qu'à la même adresse : une redirection vers une autre est refusée.
        allowRedirect: (url) => url.origin === origin,
      })
      report.calls++
      if (reply.skipped) {
        await this.sleep(BUSY_RETRY_MS)
        continue
      }
      report.processed += reply.processed
      report.offersCreated += reply.offersCreated
      report.remaining = reply.remaining
      if (reply.aiUnavailable) return { ...report, outcome: 'ai-unavailable' }
      if (reply.remaining === 0) return { ...report, outcome: 'done' }
      if (reply.processed === 0) return { ...report, outcome: 'no-progress' }
    }
    return { ...report, outcome: 'time-limit' }
  }
}
