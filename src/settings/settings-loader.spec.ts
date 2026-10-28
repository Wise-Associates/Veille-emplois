import 'reflect-metadata'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Logger } from '@nestjs/common'
import { loadConfig } from '../config.js'
import { HttpClient } from '../http/http-client.js'
import { DEFAULT_SETTINGS } from './defaults.js'
import { SettingsLoader } from './settings-loader.js'

Logger.overrideLogger(false)

// Jeton fictif. Serveur local : la route ne répond qu'avec le bon jeton ; /redirige/meme-origine redirige vers elle à la
// même adresse, /redirige/ailleurs vers localhost, une autre origine que 127.0.0.1 (comme mybestconsultant.fr → www).
const TOKEN = 'jeton-fictif-0123456789abcdef0123456789'
const receivedAuthorizations: (string | undefined)[] = []
let server: Server
let base = ''
before(async () => {
  server = createServer((req, res) => {
    const { port } = server.address() as AddressInfo
    if (req.url === '/redirige/meme-origine') return res.writeHead(307, { Location: '/api/veille/config' }).end()
    if (req.url === '/redirige/ailleurs') return res.writeHead(307, { Location: `http://localhost:${port}/api/veille/config` }).end()
    receivedAuthorizations.push(req.headers.authorization)
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"Non autorisé"}')
    const body = { version: 3, savedAt: '2026-10-27T09:00:00.000Z', config: DEFAULT_SETTINGS }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(() => server.close())

const loaderFor = (path: string) =>
  new SettingsLoader(new HttpClient(), loadConfig({ VEILLE_CONFIG_URL: `${base}${path}`, VEILLE_CONFIG_TOKEN: TOKEN }, true))

describe('lecture des réglages dans MyBestConsultant', () => {
  it('envoie le jeton et retient la version en vigueur', async () => {
    const chosen = await loaderFor('/api/veille/config').load(undefined)
    assert.equal(chosen.origin, 'remote')
    assert.equal(chosen.snapshot?.version, 3)
  })

  it('suit une redirection vers la même adresse, jeton compris', async () => {
    const chosen = await loaderFor('/redirige/meme-origine').load(undefined)
    assert.equal(chosen.origin, 'remote')
  })

  it('refuse une redirection vers une autre adresse sans y envoyer le jeton, et indique l\'adresse à configurer', async () => {
    receivedAuthorizations.length = 0
    const chosen = await loaderFor('/redirige/ailleurs').load(undefined)
    assert.equal(chosen.origin, 'defaults')
    assert.match(chosen.warning ?? '', /VEILLE_CONFIG_URL redirigée vers http:\/\/localhost:\d+\/api\/veille\/config : indiquez directement cette adresse/)
    assert.deepEqual(receivedAuthorizations, [])
  })
})
