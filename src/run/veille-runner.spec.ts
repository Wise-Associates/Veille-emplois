import 'reflect-metadata'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Logger } from '@nestjs/common'
import type { AppConfig, DigestMode } from '../config.js'
import type { RenderedEmail } from '../digest/format.js'
import type { Mailer } from '../mail/mailer.js'
import { PartialDeliveryError, type ScanService } from '../scan.service.js'
import { RunInProgressError, type StateStore } from '../state/state-store.js'
import type { AoInboxSync, SyncReport } from './ao-inbox-sync.js'
import { EXIT_CODES, VeilleRunner } from './veille-runner.js'

Logger.overrideLogger(false)

interface Options {
  scan?: () => Promise<void>
  sync?: () => Promise<SyncReport | null>
  lock?: () => Promise<() => Promise<void>>
  sendAlert?: () => Promise<void>
  dryRun?: boolean
}

function runnerWith(options: Options = {}) {
  const calls: string[] = []
  const alerts: RenderedEmail[] = []
  const modes: (DigestMode | undefined)[] = []
  const scan = {
    run: async ({ digestMode }: { digestMode?: DigestMode } = {}) => {
      calls.push('passage')
      modes.push(digestMode)
      await options.scan?.()
    },
  } as unknown as ScanService
  const store = {
    acquireRunLock:
      options.lock ??
      (async () => {
        calls.push('verrou')
        return async () => {
          calls.push('libération')
        }
      }),
  } as unknown as StateStore
  const sync = {
    run: async () => {
      calls.push('boîte AO')
      return options.sync ? options.sync() : { calls: 1, processed: 2, offersCreated: 2, remaining: 0, outcome: 'done' }
    },
  } as unknown as AoInboxSync
  const mailer = {
    sendAlert: async (email: RenderedEmail) => {
      calls.push('alerte')
      await options.sendAlert?.()
      alerts.push(email)
    },
    close: () => calls.push('fermeture SMTP'),
  } as unknown as Mailer
  const config = { dryRun: options.dryRun ?? false } as AppConfig
  const runner = new VeilleRunner(scan, store, sync, mailer, { now: () => new Date('2026-11-05T05:00:00Z') }, config)
  return { runner, calls, alerts, modes }
}

describe('déroulé d\'un passage (planifié ou lancé à la main)', () => {
  it('prend le verrou, passe, fait lire la boîte AO, libère le verrou et ferme la connexion SMTP, sans alerte', async () => {
    const { runner, calls, alerts, modes } = runnerWith()
    assert.equal(await runner.run({ digestMode: 'problems' }), 'complete')
    assert.deepEqual(calls, ['verrou', 'passage', 'boîte AO', 'libération', 'fermeture SMTP'])
    assert.deepEqual(modes, ['problems'])
    assert.equal(alerts.length, 0)
  })

  it('n\'envoie rien et ne prend pas le verrou en essai', async () => {
    const { runner, calls } = runnerWith({ dryRun: true })
    assert.equal(await runner.run(), 'complete')
    assert.deepEqual(calls, ['passage', 'fermeture SMTP'])
  })

  it('ne lance pas un passage quand un autre tient le verrou, sans alerte', async () => {
    const { runner, calls } = runnerWith({
      lock: async () => {
        throw new RunInProgressError('Un passage est déjà en cours (commencé le 05/11/2026 à 06:00) : celui-ci n\'est pas lancé.')
      },
    })
    assert.equal(await runner.run(), 'busy')
    assert.deepEqual(calls, ['fermeture SMTP'])
  })

  it('prévient l\'équipe d\'un passage interrompu, sans faire lire la boîte AO', async () => {
    const { runner, calls, alerts } = runnerWith({
      scan: async () => {
        throw new Error('Fichier d\'état invalide (version fictive)')
      },
    })
    assert.equal(await runner.run(), 'failed')
    assert.deepEqual(calls, ['verrou', 'passage', 'libération', 'alerte', 'fermeture SMTP'])
    assert.match(alerts[0]?.text ?? '', /Passage interrompu, état non enregistré : Fichier d'état invalide \(version fictive\)/)
    assert.match(alerts[0]?.text ?? '', /État non enregistré/)
  })

  it('fait lire la boîte AO après un envoi incomplet (des offres sont parties), puis prévient l\'équipe', async () => {
    const { runner, calls, alerts } = runnerWith({
      scan: async () => {
        throw new PartialDeliveryError('1 offre(s) refusée(s) par le serveur d\'envoi')
      },
    })
    assert.equal(await runner.run(), 'partial')
    assert.deepEqual(calls, ['verrou', 'passage', 'boîte AO', 'libération', 'alerte', 'fermeture SMTP'])
    assert.match(alerts[0]?.text ?? '', /État enregistré/)
  })

  it('prévient l\'équipe quand MyBestConsultant refuse de lire la boîte AO', async () => {
    const { runner, alerts } = runnerWith({
      sync: async () => {
        throw new Error('HTTP 401 sur https://mbc.exemple.test/api/cron/ao-inbox')
      },
    })
    assert.equal(await runner.run(), 'partial')
    assert.match(alerts[0]?.text ?? '', /Lecture de la boîte AO par MyBestConsultant impossible : HTTP 401/)
  })

  it('garde son résultat si l\'alerte elle-même ne part pas (serveur d\'envoi en panne)', async () => {
    const { runner, calls } = runnerWith({
      scan: async () => {
        throw new Error('panne fictive')
      },
      sendAlert: async () => {
        throw new Error('SMTP indisponible')
      },
    })
    assert.equal(await runner.run(), 'failed')
    assert.deepEqual(calls.slice(-2), ['alerte', 'fermeture SMTP'])
  })

  it('signale un verrou qui n\'a pas pu être retiré (passages refusés pendant deux heures)', async () => {
    const { runner, alerts } = runnerWith({
      lock: async () => async () => {
        throw new Error('EACCES fictif')
      },
    })
    assert.equal(await runner.run(), 'partial')
    assert.match(alerts[0]?.text ?? '', /Verrou du fichier d'état non retiré \(passages refusés pendant deux heures\) : EACCES fictif/)
  })

  it('prévient l\'équipe d\'un passage tué net (verrou retrouvé au redémarrage), puis ferme la connexion SMTP', async () => {
    const { runner, calls, alerts } = runnerWith()
    await runner.reportInterruptedRun(new Date('2026-11-05T08:30:00Z'))
    assert.deepEqual(calls, ['alerte', 'fermeture SMTP'])
    assert.match(alerts[0]?.subject ?? '', /échec du passage du 05\/11\/2026 à 09:30/)
    assert.match(alerts[0]?.text ?? '', /arrêt brutal du conteneur/)
    assert.match(alerts[0]?.text ?? '', /État non enregistré/)
  })

  it('donne les codes de sortie lus par l\'ancien workflow : 3 seulement quand l\'état est enregistré', () => {
    assert.deepEqual(EXIT_CODES, { complete: 0, partial: 3, failed: 1, busy: 1 })
  })
})
