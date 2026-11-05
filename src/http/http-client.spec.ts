import 'reflect-metadata'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Logger } from '@nestjs/common'
import { HttpClient, HttpError, isSiteUnavailable } from './http-client.js'

Logger.overrideLogger(false)

// Serveur local fictif : /flux redirige vers /interne (adresse « interne ») ou vers /ok selon le test.
let server: Server
let base = ''
before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/vers-interne') return res.writeHead(302, { Location: '/interne' }).end()
    if (req.url === '/vers-ok') return res.writeHead(302, { Location: '/ok' }).end()
    if (req.url === '/gros') return res.writeHead(200, { 'Content-Type': 'application/pdf' }).end(Buffer.alloc(4096, 1))
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end(req.url === '/interne' ? 'secret' : 'flux fictif')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(() => server.close())

describe('redirections d\'une adresse saisie dans les réglages', () => {
  it('refuse une redirection que la règle n\'autorise pas, sans lire la page visée', async () => {
    const http = new HttpClient()
    await assert.rejects(http.text(`${base}/vers-interne`, { retry: false, allowRedirect: (url) => url.pathname !== '/interne' }), /Redirection refusée/)
  })

  it('suit une redirection autorisée', async () => {
    const http = new HttpClient()
    assert.equal(await http.text(`${base}/vers-ok`, { retry: false, allowRedirect: () => true }), 'flux fictif')
  })
})

describe('fichiers et pannes', () => {
  it('arrête la lecture d\'un fichier au-delà de la taille demandée', async () => {
    const http = new HttpClient()
    await assert.rejects(http.binary(`${base}/gros`, { retry: false, maxBytes: 1024 }), /trop volumineuse \(plus de 1 Ko\)/)
    assert.equal((await http.binary(`${base}/gros`, { retry: false })).byteLength, 4096)
  })

  it('distingue un site injoignable ou en panne d\'une réponse propre à la ressource demandée', () => {
    assert.equal(isSiteUnavailable(new HttpError('https://exemple.test injoignable (délai dépassé)')), true)
    assert.equal(isSiteUnavailable(new HttpError('HTTP 503 sur https://exemple.test/a', 503)), true)
    assert.equal(isSiteUnavailable(new HttpError('HTTP 429 sur https://exemple.test/a', 429)), true)
    assert.equal(isSiteUnavailable(new HttpError('HTTP 404 sur https://exemple.test/a', 404)), false)
    assert.equal(isSiteUnavailable(new Error("le fichier reçu n'est pas un PDF")), false)
  })
})
