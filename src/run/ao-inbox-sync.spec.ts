import 'reflect-metadata'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Logger } from '@nestjs/common'
import type { AppConfig } from '../config.js'
import { HttpError, type HttpClient, type RequestOptions } from '../http/http-client.js'
import { AoInboxSync } from './ao-inbox-sync.js'

Logger.overrideLogger(false)

const URL_AO = 'https://mbc.exemple.test/api/cron/ao-inbox'
const TOKEN = 'secret-fictif-de-16-caracteres'

type Reply = { processed: number; remaining: number; offersCreated?: number; skipped?: boolean; aiUnavailable?: boolean } | Error

/** Horloge, attentes et réponses fictives ; chaque appel à MyBestConsultant « dure » `callMs`. */
function syncWith(replies: Reply[], options: { configured?: boolean; callMs?: number } = {}) {
  let now = 0
  const sleeps: number[] = []
  const calls: { url: string; options: RequestOptions }[] = []
  const http = {
    json: async (url: string, schema: { parse(value: unknown): unknown }, requestOptions: RequestOptions) => {
      calls.push({ url, options: requestOptions })
      now += options.callMs ?? 20_000
      const reply = replies.shift()
      if (!reply) throw new Error('appel de trop')
      if (reply instanceof Error) throw reply
      return schema.parse({ offersCreated: 0, skipped: false, aiUnavailable: false, ...reply })
    },
  } as unknown as HttpClient
  const config = { aoSync: options.configured === false ? null : { url: URL_AO, token: TOKEN } } as AppConfig
  const sleep = async (ms: number) => {
    sleeps.push(ms)
    now += ms
  }
  return { sync: new AoInboxSync(http, config, { now: () => new Date(now) }, sleep), calls, sleeps }
}

describe('lecture de la boîte AO par MyBestConsultant après le passage', () => {
  it('ne fait rien quand la route n\'est pas configurée', async () => {
    const { sync, calls, sleeps } = syncWith([], { configured: false })
    assert.equal(await sync.run(), null)
    assert.equal(calls.length, 0)
    assert.equal(sleeps.length, 0)
  })

  it('attend l\'arrivée des derniers e-mails, puis rappelle tant qu\'il en reste, avec le secret, vers la même adresse seulement', async () => {
    const { sync, calls, sleeps } = syncWith([
      { processed: 25, remaining: 30, offersCreated: 20 },
      { processed: 25, remaining: 5, offersCreated: 18 },
      { processed: 5, remaining: 0, offersCreated: 4 },
    ])
    assert.deepEqual(await sync.run(), { calls: 3, processed: 55, offersCreated: 42, remaining: 0, outcome: 'done' })
    assert.equal(sleeps[0], 30_000)
    assert.equal(calls[0]?.url, URL_AO)
    assert.deepEqual(calls[0]?.options.headers, { Authorization: `Bearer ${TOKEN}` })
    assert.equal(calls[0]?.options.retry, false)
    const allow = calls[0]?.options.allowRedirect
    assert.ok(allow)
    assert.equal(allow(new URL('https://mbc.exemple.test/autre')), true)
    assert.equal(allow(new URL('https://autre.exemple.test/api/cron/ao-inbox')), false, 'le secret ne part jamais vers une autre adresse')
  })

  it('réessaie 30 s plus tard quand une autre lecture tient la boîte', async () => {
    const { sync, sleeps } = syncWith([{ processed: 0, remaining: 0, skipped: true }, { processed: 3, remaining: 0 }])
    assert.equal((await sync.run())?.outcome, 'done')
    assert.deepEqual(sleeps, [30_000, 30_000])
  })

  it('s\'arrête sans erreur quand l\'IA de MyBestConsultant est indisponible, ou que rien n\'avance', async () => {
    assert.equal((await syncWith([{ processed: 2, remaining: 10, aiUnavailable: true }]).sync.run())?.outcome, 'ai-unavailable')
    assert.equal((await syncWith([{ processed: 0, remaining: 4 }]).sync.run())?.outcome, 'no-progress', 'e-mails en erreur : inutile de rappeler')
  })

  it('ne commence plus d\'appel qui finirait après 15 minutes', async () => {
    const replies = Array.from({ length: 5 }, () => ({ processed: 25, remaining: 100 }))
    const { sync, calls } = syncWith(replies, { callMs: 300_000 })
    assert.deepEqual(await sync.run(), { calls: 2, processed: 50, offersCreated: 0, remaining: 100, outcome: 'time-limit' })
    assert.equal(calls.length, 2)
  })

  it('cesse de rappeler quand le conteneur s\'arrête', async () => {
    let stop = false
    const { sync, calls } = syncWith([{ processed: 25, remaining: 50 }, { processed: 25, remaining: 25 }])
    const report = await sync.run(() => {
      const answer = stop
      stop = true
      return answer
    })
    assert.equal(report?.outcome, 'stopped')
    assert.equal(calls.length, 1)
  })

  it('remonte le refus de MyBestConsultant sans jamais citer le secret', async () => {
    const { sync } = syncWith([new HttpError(`HTTP 401 sur ${URL_AO}`, 401)])
    await assert.rejects(sync.run(), (error: Error) => /HTTP 401/.test(error.message) && !error.message.includes(TOKEN))
  })
})
