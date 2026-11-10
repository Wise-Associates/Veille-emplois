import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parisLocalIso } from '../dates.js'
import { deadlineFromNoticeText, pdfText } from './notice-deadline.js'

/**
 * PDF minimal (une page, Helvetica en WinAnsi) contenant `lines`, pour lire un vrai fichier sans avis réel : les avis
 * nomment le contact de l'acheteur. Les décalages de la table xref sont calculés, comme dans un vrai PDF.
 */
function minimalPdf(lines: string[]): Uint8Array {
  const escape = (line: string) => line.replace(/[\\()]/g, (c) => `\\${c}`)
  const stream = `BT /F1 10 Tf 40 800 Td 12 TL ${lines.map((line) => `(${escape(line)}) Tj T*`).join(' ')} ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(body, 'latin1')
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  // Latin-1 : « é » devient l'octet 0xE9 de WinAnsi.
  return new Uint8Array(Buffer.from(body, 'latin1'))
}

/** Jour du passage : avant toutes les dates des avis fictifs, sauf mention contraire. */
const TODAY = '2026-10-20'

describe('date limite écrite dans un avis officiel', () => {
  it('lit la date limite des demandes de participation d\'un avis du BOAMP, à l\'heure de Paris', () => {
    const text = 'Variantes:Non autorisée Date limite de réception des demandes de participation:30/11/2026à 12:00 Conditions du marché'
    assert.equal(deadlineFromNoticeText(text, TODAY), '2026-11-30T12:00:00+01:00')
  })

  it('lit la date limite des offres d\'un avis de TED avec son fuseau, sans prendre celle des questions', () => {
    const text =
      'Date limite de demande d’informations complémentaires: 28/10/2026 11:00:00 (UTC+02:00)\n' +
      "Date limite de réception des offres: 04/11/2026 11:00:00 (UTC+02:00) Heure de l'Europe"
    assert.equal(deadlineFromNoticeText(text, TODAY), '2026-11-04T11:00:00+02:00')
  })

  it('garde la plus proche quand l\'avis en donne plusieurs (lots, candidatures puis offres)', () => {
    const text =
      'Lot 1 Date limite de réception des offres : 15/12/2026 à 12:00\n' +
      'Lot 2 Date limite de réception des demandes de participation : 01/12/2026 à 16h30'
    assert.equal(deadlineFromNoticeText(text, TODAY), '2026-12-01T16:30:00+01:00')
  })

  it('avis à plusieurs lots : la plus proche encore ouverte, jamais un lot clos qui ferait écarter l\'avis ; tous clos : la plus tardive', () => {
    const text =
      'Lot 1 Date limite de réception des offres : 01/11/2026 à 12:00\n' +
      'Lot 2 Date limite de réception des offres : 01/12/2026 à 12:00'
    assert.equal(deadlineFromNoticeText(text, '2026-11-10'), '2026-12-01T12:00:00+01:00')
    assert.equal(deadlineFromNoticeText(text, '2026-12-02'), '2026-12-01T12:00:00+01:00', 'tous clos : l\'avis est échu')
    assert.equal(deadlineFromNoticeText(text, '2026-11-01'), '2026-11-01T12:00:00+01:00', 'le jour même, la date compte encore')
  })

  it('accepte une date sans heure, coupée sur deux lignes', () => {
    assert.equal(deadlineFromNoticeText('Date limite de réception\ndes offres :\n20/01/2027', TODAY), '2027-01-20')
  })

  it('ne renvoie rien sans ligne de date limite, ni pour une date impossible', () => {
    assert.equal(deadlineFromNoticeText('Date de début : 01/12/2026. Durée : 12 mois.', TODAY), undefined)
    assert.equal(deadlineFromNoticeText('Date limite de réception des offres : 31/02/2026 à 12:00', TODAY), undefined)
    assert.equal(deadlineFromNoticeText('Date limite de réception des offres : 12/13/2026', TODAY), undefined)
  })

  it('lit le texte d\'un vrai fichier PDF', async () => {
    const pdf = minimalPdf(['Avis de marché fictif', 'Date limite de réception des offres : 18/12/2026 à 12:00', 'Fin'])
    const text = await pdfText(pdf)
    assert.match(text, /Avis de marché fictif/)
    assert.equal(deadlineFromNoticeText(text, TODAY), '2026-12-18T12:00:00+01:00')
    assert.equal(pdf[0], 0x25, 'le contenu reste lisible après la lecture (joint ensuite à l\'e-mail)')
    assert.equal(pdf.byteLength > 0, true)
  })

  it('lève une erreur pour un fichier qui n\'est pas un PDF lisible', async () => {
    await assert.rejects(pdfText(new TextEncoder().encode('%PDF-1.6\nTronqué')))
  })
})

describe('heure de Paris', () => {
  it('donne le décalage d\'hiver et d\'été', () => {
    assert.equal(parisLocalIso('2026-11-30', '12:00'), '2026-11-30T12:00:00+01:00')
    assert.equal(parisLocalIso('2026-07-01', '09:30'), '2026-07-01T09:30:00+02:00')
  })
})
