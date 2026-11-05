import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { HttpClient, RequestOptions } from '../http/http-client.js'
import { checkNoticePdf, MAX_NOTICE_PDF_BYTES, NoticePdfReader, noticePdfFilename } from './notice-pdf.js'

const PDF = new TextEncoder().encode('%PDF-1.6\nAvis fictif')

function readerWith(body: Uint8Array = PDF) {
  const requests: { url: string; options: RequestOptions }[] = []
  const http = {
    binary: async (url: string, options: RequestOptions) => {
      requests.push({ url, options })
      return body
    },
  } as unknown as HttpClient
  return { reader: new NoticePdfReader(http), requests }
}

describe('avis officiel en PDF', () => {
  it('télécharge l\'avis depuis le BOAMP ou TED, avec le délai court d\'une page d\'offre', async () => {
    const { reader, requests } = readerWith()
    const pdf = await reader.read('https://www.boamp.fr/telechargements/FILES/PDF/2026/10/26-000001.pdf', '26-000001')
    assert.deepEqual(pdf, { filename: 'avis-26-000001.pdf', content: PDF, contentType: 'application/pdf' })
    await reader.read('https://ted.europa.eu/fr/notice/700001-2026/pdf', '700001-2026')
    assert.equal(requests.length, 2)
    assert.equal(requests[0]?.options.timeoutMs, 15_000)
    assert.equal(requests[0]?.options.retry, false)
    assert.equal(requests[0]?.options.maxBytes, MAX_NOTICE_PDF_BYTES, 'lecture arrêtée au-delà de 5 Mo')
  })

  it('ne suit une redirection que vers le BOAMP ou TED, en https', async () => {
    const { reader, requests } = readerWith()
    await reader.read('https://ted.europa.eu/fr/notice/700001-2026/pdf', '700001-2026')
    const allow = requests[0]?.options.allowRedirect
    assert.ok(allow, 'redirections vérifiées')
    assert.equal(allow(new URL('https://ted.europa.eu/fr/notice/700001-2026/pdf?v=2')), true)
    assert.equal(allow(new URL('https://www.boamp.fr/telechargements/x.pdf')), true)
    assert.equal(allow(new URL('http://ted.europa.eu/fr/notice/700001-2026/pdf')), false)
    assert.equal(allow(new URL('https://exemple.test/avis.pdf')), false)
    assert.equal(allow(new URL('https://ted.europa.eu.exemple.test/avis.pdf')), false)
  })

  it('refuse une adresse hors du BOAMP et de TED sans la demander', async () => {
    const { reader, requests } = readerWith()
    await assert.rejects(reader.read('https://exemple.test/avis.pdf', '26-000001'), /adresse d'avis PDF inattendue/)
    await assert.rejects(reader.read('http://www.boamp.fr/avis.pdf', '26-000001'), /adresse d'avis PDF inattendue/)
    assert.equal(requests.length, 0)
  })

  it('refuse une page d\'erreur HTML à la place du PDF', async () => {
    assert.throws(() => checkNoticePdf(new TextEncoder().encode('<!doctype html><p>Erreur</p>')), /n'est pas un PDF/)
    assert.throws(() => checkNoticePdf(new Uint8Array(0)), /n'est pas un PDF/)
    assert.doesNotThrow(() => checkNoticePdf(PDF))
    const { reader } = readerWith(new TextEncoder().encode('<html>'))
    await assert.rejects(reader.read('https://www.boamp.fr/avis.pdf', '26-000001'), /n'est pas un PDF/)
  })

  it('nomme la pièce jointe d\'après la référence de l\'avis, sans caractère de chemin', () => {
    assert.equal(noticePdfFilename('700001-2026'), 'avis-700001-2026.pdf')
    assert.equal(noticePdfFilename('../26 000001'), 'avis-_26_000001.pdf')
  })
})
