import 'reflect-metadata'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Logger } from '@nestjs/common'
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule'
import { Test } from '@nestjs/testing'
import { APP_CONFIG, type AppConfig, type DigestMode } from '../config.js'
import { Mailer } from '../mail/mailer.js'
import { StateStore } from '../state/state-store.js'
import { VeilleRunner, type RunOutcome } from './veille-runner.js'
import { VeilleScheduler } from './veille-scheduler.js'

Logger.overrideLogger(false)

/** Passage fictif qui ne se termine que quand le test le décide ; `events` : ordre des étapes observées. */
function controlledRunner(events: string[] = []) {
  const runs: { digestMode?: DigestMode; shouldStop?: () => boolean; finish: (outcome: RunOutcome) => void }[] = []
  const interrupted: (Date | null)[] = []
  const runner = {
    run: (options: { digestMode?: DigestMode; shouldStop?: () => boolean }) =>
      new Promise<RunOutcome>((resolve) => {
        runs.push({
          ...options,
          finish: (outcome) => {
            events.push('fin du passage')
            resolve(outcome)
          },
        })
      }),
    reportInterruptedRun: async (since: Date | null) => {
      interrupted.push(since)
    },
  } as unknown as VeilleRunner
  return { runner, runs, interrupted }
}

const registry = {} as SchedulerRegistry
const store = {} as StateStore
/** Fichier d'état fictif ; `leftover` : verrou laissé par un passage interrompu. */
const storeWith = (leftover: Date | null | undefined) => ({ clearLeftoverLock: async () => leftover }) as unknown as StateStore

describe('passages planifiés', () => {
  it('envoie toujours le récapitulatif au passage du matin, seulement en cas de problème dans la journée', async () => {
    const { runner, runs } = controlledRunner()
    const scheduler = new VeilleScheduler(runner, registry, store)
    const morning = scheduler.morning()
    runs[0]?.finish('complete')
    await morning
    const daytime = scheduler.daytime()
    runs[1]?.finish('complete')
    await daytime
    assert.deepEqual(runs.map((run) => run.digestMode), ['always', 'problems'])
  })

  it('saute un passage planifié tant que le précédent n\'est pas terminé', async () => {
    const { runner, runs } = controlledRunner()
    const scheduler = new VeilleScheduler(runner, registry, store)
    const first = scheduler.daytime()
    await scheduler.daytime()
    assert.equal(runs.length, 1, 'second passage sauté')
    runs[0]?.finish('complete')
    await first
    const third = scheduler.daytime()
    assert.equal(runs.length, 2, 'le suivant repart normalement')
    runs[1]?.finish('complete')
    await third
  })

  it('à l\'arrêt du conteneur, attend la fin du passage en cours, le prévient, et n\'en lance plus', async () => {
    const { runner, runs } = controlledRunner()
    const scheduler = new VeilleScheduler(runner, registry, store)
    const running = scheduler.morning()
    let stopped = false
    const shutdown = scheduler.beforeApplicationShutdown().then(() => {
      stopped = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(stopped, false, 'attend le passage en cours')
    assert.equal(runs[0]?.shouldStop?.(), true, 'la lecture de la boîte AO ne fait plus de nouvel appel')
    runs[0]?.finish('complete')
    await running
    await shutdown
    assert.equal(stopped, true)
    await scheduler.daytime()
    assert.equal(runs.length, 1, 'plus de passage après l\'arrêt')
  })

  it('planifie le matin à 5 h UTC et la journée à 9 h, 13 h et 17 h UTC', async () => {
    const { runner } = controlledRunner()
    const module = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [VeilleScheduler, { provide: VeilleRunner, useValue: runner }, { provide: StateStore, useValue: storeWith(undefined) }],
    }).compile()
    // Démarrage complet : passages enregistrés, puis prochains passages journalisés et fichier de la sonde écrit.
    await module.init()
    try {
      const scheduled = module.get(SchedulerRegistry)
      const morning = scheduled.getCronJob('veille-matin').nextDates(3).map((date) => date.toUTC().toFormat('HH:mm'))
      const day = scheduled.getCronJob('veille-journee').nextDates(6).map((date) => date.toUTC().toFormat('HH:mm'))
      assert.deepEqual([...new Set(morning)], ['05:00'])
      assert.deepEqual([...new Set(day)].sort(), ['09:00', '13:00', '17:00'])
    } finally {
      await module.close()
    }
  })

  it('au démarrage, retire le verrou d\'un passage tué net et prévient l\'équipe ; rien sans verrou', async () => {
    const registryWithJobs = { getCronJob: () => ({ nextDate: () => ({ toUTC: () => ({ toFormat: () => '06/11/2026 05:00 UTC' }) }) }) } as unknown as SchedulerRegistry
    const crashed = controlledRunner()
    await new VeilleScheduler(crashed.runner, registryWithJobs, storeWith(new Date('2026-11-05T08:30:00Z'))).onApplicationBootstrap()
    assert.deepEqual(crashed.interrupted, [new Date('2026-11-05T08:30:00Z')])
    const clean = controlledRunner()
    await new VeilleScheduler(clean.runner, registryWithJobs, storeWith(undefined)).onApplicationBootstrap()
    assert.deepEqual(clean.interrupted, [])
  })

  it('à l\'arrêt réel du module, ne ferme la connexion SMTP qu\'après la fin du passage en cours', async () => {
    const events: string[] = []
    class ObservedMailer extends Mailer {
      override close(): void {
        events.push('fermeture SMTP')
        super.close()
      }
    }
    const { runner, runs } = controlledRunner(events)
    const module = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        VeilleScheduler,
        { provide: VeilleRunner, useValue: runner },
        { provide: StateStore, useValue: storeWith(undefined) },
        { provide: APP_CONFIG, useValue: { mail: null } as AppConfig },
        { provide: Mailer, useClass: ObservedMailer },
      ],
    }).compile()
    await module.init()
    const running = module.get(VeilleScheduler).morning()
    const closing = module.close()
    // Le passage est toujours terminé et le module fermé, même si une vérification échoue : sinon les passages
    // planifiés gardent le processus de test en vie.
    try {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
      assert.deepEqual(events, [], 'connexion encore ouverte pendant le passage')
    } finally {
      runs[0]?.finish('complete')
      await running
      await closing
    }
    assert.deepEqual(events, ['fin du passage', 'fermeture SMTP'])
  })
})
