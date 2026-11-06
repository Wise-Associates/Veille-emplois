import 'reflect-metadata'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Logger } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { CLOCK } from './clock.js'
import { APP_CONFIG, type AppConfig } from './config.js'
import type { EmailAttachment, RenderedEmail } from './digest/format.js'
import type { Listing, ListingSource } from './listing.js'
import { HttpError } from './http/http-client.js'
import { Mailer } from './mail/mailer.js'
import { PartialDeliveryError, ScanService } from './scan.service.js'
import { DEFAULT_SETTINGS } from './settings/defaults.js'
import { SettingsLoader } from './settings/settings-loader.js'
import type { ChosenSettings } from './settings/veille-settings.js'
import { SOURCE_FACTORY } from './sources/sources.js'
import { EMPTY_STATE, type VeilleState } from './state/run-state.js'
import { StateStore } from './state/state-store.js'
import { NoticePdfReader } from './tenders/notice-pdf.js'

Logger.overrideLogger(false)

const offer = (id: string, overrides: Partial<Listing> = {}): Listing => ({
  kind: 'job',
  id,
  organisationId: 'dinum',
  title: `Développeur fictif ${id}`,
  url: `https://exemple.test/${id}`,
  details: [],
  ...overrides,
})

const source = (id: string, listings: Listing[] | Error, extra: Partial<ListingSource> = {}): ListingSource => ({
  id,
  label: `Source ${id}`,
  kind: 'job',
  fetch: async () => {
    if (listings instanceof Error) throw listings
    return { listings, ignoredIds: [] }
  },
  ...extra,
})

const known: VeilleState = { ...EMPTY_STATE, sources: { a: { seen: { A1: '2026-10-21' }, lastCount: 1, lastSuccessOn: '2026-10-21' } } }

interface Options {
  sources: ListingSource[]
  sendOffer?: (email: RenderedEmail) => Promise<void>
  sendDigest?: (email: RenderedEmail) => Promise<void>
  dryRun?: boolean
  maxOfferEmailsPerRun?: number
  clock?: { now(): Date }
  digestMode?: AppConfig['digestMode']
  /** Réglages renvoyés au passage (par défaut : ceux du dépôt, sans avertissement). */
  settings?: Partial<ChosenSettings>
  /** Copie du jour de l'état impossible (StateStore.save). */
  stateWarning?: string
  /** Téléchargement de l'avis officiel en PDF (par défaut : jamais appelé, aucune offre n'en a). */
  readPdf?: (url: string, reference: string) => Promise<EmailAttachment>
}

async function scanWith(options: Options) {
  const calls: string[] = []
  const offers: RenderedEmail[] = []
  const digests: RenderedEmail[] = []
  const saved: VeilleState[] = []
  /** Adresses d'avis PDF demandées : une offre sans adresse, ou échue, ne doit jamais en demander. */
  const pdfRequests: string[] = []
  const config: AppConfig = { stateFile: 'inutilise.json', dryRun: options.dryRun ?? false, maxOfferEmailsPerRun: options.maxOfferEmailsPerRun ?? 200, digestMode: options.digestMode ?? 'always', mail: null, settings: null, aoSync: null }
  const settingsLoader = {
    load: async (snapshot: VeilleState['settings']): Promise<ChosenSettings> => ({ settings: DEFAULT_SETTINGS, origin: 'defaults', warning: null, snapshot, ...options.settings }),
  }
  const mailer = {
    sendOffer: async (email: RenderedEmail) => {
      calls.push('offre')
      await options.sendOffer?.(email)
      offers.push(email)
    },
    sendDigest: async (email: RenderedEmail) => {
      calls.push('récapitulatif')
      await options.sendDigest?.(email)
      digests.push(email)
    },
  }
  const module = await Test.createTestingModule({
    providers: [
      ScanService,
      { provide: SOURCE_FACTORY, useValue: () => options.sources },
      { provide: SettingsLoader, useValue: settingsLoader },
      { provide: CLOCK, useValue: options.clock ?? { now: () => new Date('2026-10-22T05:00:00Z') } },
      { provide: APP_CONFIG, useValue: config },
      {
        provide: StateStore,
        useValue: { load: async () => known, save: async (state: VeilleState) => (calls.push('état'), saved.push(state), { warning: options.stateWarning ?? null }) },
      },
      { provide: Mailer, useValue: mailer },
      {
        provide: NoticePdfReader,
        useValue: {
          read: async (url: string, reference: string) => {
            pdfRequests.push(url)
            if (!options.readPdf) throw new Error('téléchargement non prévu par ce test')
            return options.readPdf(url, reference)
          },
        },
      },
    ],
  }).compile()
  return { scan: module.get(ScanService), calls, offers, digests, saved, pdfRequests }
}

const seenIds = (state: VeilleState | undefined, sourceId: string) => Object.keys(state?.sources[sourceId]?.seen ?? {}).sort()

describe('passage de la veille', () => {
  it('envoie chaque nouvelle offre dans son propre e-mail, retient l\'état, puis envoie le récapitulatif', async () => {
    const { scan, calls, offers, digests, saved } = await scanWith({ sources: [source('a', [offer('A1'), offer('A2'), offer('A3')])] })
    const summary = await scan.run()
    assert.deepEqual(calls, ['offre', 'offre', 'état', 'récapitulatif'])
    assert.deepEqual(offers.map((o) => o.subject), ["Offre d'emploi — DINUM — Développeur fictif A2", "Offre d'emploi — DINUM — Développeur fictif A3"])
    assert.deepEqual(summary.sent.map((l) => l.id), ['A2', 'A3'])
    assert.deepEqual(seenIds(saved[0], 'a'), ['A1', 'A2', 'A3'])
    assert.match(digests[0]?.subject ?? '', /2 offres d'emploi envoyées/)
  })

  it('complète l\'offre par sa page, et l\'envoie quand même si la page est illisible', async () => {
    const describe = async (listing: Listing) => {
      if (listing.id === 'B2') throw new Error('page modifiée')
      return { description: 'Missions fictives', deadline: '2026-11-16' }
    }
    const { scan, offers, digests } = await scanWith({ sources: [source('b', [offer('B1'), offer('B2')], { describe })] })
    await scan.run()
    assert.match(offers[0]?.text ?? '', /Missions fictives/)
    assert.match(offers[0]?.text ?? '', /Date limite de candidature : 16\/11\/2026/)
    assert.match(offers[1]?.text ?? '', /Pas de description dans la source/)
    assert.match(digests[0]?.text ?? '', /Source b : 1 offre\(s\) envoyée\(s\) sans le détail de leur page/)
  })

  it('n\'envoie pas plus que le plafond : le reste reste nouveau pour le passage suivant', async () => {
    const { scan, offers, saved, digests } = await scanWith({
      sources: [source('a', [offer('A2'), offer('A3'), offer('A4')])],
      maxOfferEmailsPerRun: 2,
    })
    const summary = await scan.run()
    assert.equal(offers.length, 2)
    assert.equal(summary.pending, 1)
    assert.equal(seenIds(saved[0], 'a').length, 3, 'A1 connue + 2 envoyées')
    assert.match(digests[0]?.subject ?? '', /— 1 en attente/)
  })

  it('n\'envoie pas une offre dont la date limite est passée, et ne la relit pas au passage suivant', async () => {
    // Date limite connue seulement par la page de l'offre (cas de Choisir le service public).
    const describe = async (listing: Listing) => ({ deadline: listing.id === 'A2' ? '2026-10-21' : '2026-11-30' })
    const { scan, offers, saved, digests } = await scanWith({ sources: [source('a', [offer('A2'), offer('A3')], { describe })] })
    const summary = await scan.run()
    assert.deepEqual(offers.map((o) => o.subject), ["Offre d'emploi — DINUM — Développeur fictif A3"])
    assert.equal(summary.outdated, 1)
    assert.equal(summary.pending, 0)
    assert.deepEqual(seenIds(saved[0], 'a'), ['A1', 'A2', 'A3'], 'A2 retenue comme traitée')
    assert.match(digests[0]?.text ?? '', /1 nouvelle offre écartée : date limite déjà passée/)
  })

  it('n\'envoie que les offres informatiques, retient les autres et les compte dans le récapitulatif', async () => {
    const { scan, offers, saved, digests } = await scanWith({ sources: [source('a', [offer('A2'), offer('A3', { title: 'Juriste fictif A3' })])] })
    const summary = await scan.run()
    assert.deepEqual(offers.map((o) => o.subject), ["Offre d'emploi — DINUM — Développeur fictif A2"])
    assert.equal(summary.outOfScope, 1)
    assert.deepEqual(seenIds(saved[0], 'a'), ['A1', 'A2', 'A3'], 'A3 retenue comme vue, jamais envoyée')
    assert.match(digests[0]?.text ?? '', /1 nouvelle offre écartée : hors projets informatiques/)
  })

  it('signale des réglages de repli dans le récapitulatif, même en mode « problèmes seulement »', async () => {
    const warning = 'Réglages de MyBestConsultant illisibles (HTTP 503) : ceux de la version 4 du 26/10/2026 sont utilisés.'
    const { scan, digests } = await scanWith({ sources: [source('a', [offer('A2')])], digestMode: 'problems', settings: { origin: 'snapshot', warning } })
    await scan.run()
    assert.match(digests[0]?.text ?? '', /Réglages de la veille : Réglages de MyBestConsultant illisibles \(HTTP 503\)/)
  })

  it('garde dans l\'état la version des réglages lue dans MyBestConsultant', async () => {
    const snapshot = { version: 5, savedAt: '2026-10-27T09:00:00.000Z', value: { schemaVersion: 1 } }
    const { scan, saved } = await scanWith({ sources: [source('a', [offer('A2')])], settings: { origin: 'remote', snapshot } })
    await scan.run()
    assert.deepEqual(saved[0]?.settings, snapshot)
  })

  it('envoie les appels d\'offres en premier', async () => {
    const { scan, offers } = await scanWith({
      sources: [source('a', [offer('A2')]), source('t', [offer('T1', { kind: 'tender', organisationId: 'insee' })])],
      maxOfferEmailsPerRun: 1,
    })
    await scan.run()
    assert.match(offers[0]?.subject ?? '', /^Appel d'offres — INSEE/)
  })

  it('arrête d\'envoyer si le serveur refuse, retient seulement ce qui est parti, et le signale', async () => {
    let count = 0
    const { scan, saved, digests } = await scanWith({
      sources: [source('a', [offer('A2'), offer('A3'), offer('A4')])],
      sendOffer: async () => {
        if (++count === 2) throw new Error('quota dépassé')
      },
    })
    await assert.rejects(scan.run(), PartialDeliveryError)
    assert.deepEqual(seenIds(saved[0], 'a'), ['A1', 'A2'], 'A3 et A4 repartiront')
    assert.match(digests[0]?.text ?? '', /Envoi des offres interrompu : quota dépassé/)
  })

  it('saute une offre refusée pour son contenu, envoie les suivantes et la retentera au passage suivant', async () => {
    const { scan, offers, saved, digests } = await scanWith({
      sources: [source('a', [offer('A2'), offer('A3'), offer('A4')])],
      sendOffer: async (email) => {
        if (email.subject.endsWith('A3')) throw Object.assign(new Error('Message failed: 554 contenu refusé'), { code: 'EMESSAGE', responseCode: 554 })
      },
    })
    await assert.rejects(scan.run(), /1 offre\(s\) refusée\(s\)/)
    assert.equal(offers.length, 2)
    assert.deepEqual(seenIds(saved[0], 'a'), ['A1', 'A2', 'A4'])
    assert.match(digests[0]?.text ?? '', /Offre refusée, retentée au prochain passage : « Développeur fictif A3 »/)
  })

  it('cesse de commencer des offres une fois le budget de temps atteint, sans erreur', async () => {
    let now = new Date('2026-10-22T05:00:00Z').getTime()
    const { scan, offers, saved } = await scanWith({
      sources: [source('a', [offer('A2'), offer('A3'), offer('A4'), offer('A5')])],
      clock: { now: () => new Date(now) },
      // Chaque envoi « dure » 10 minutes : le budget de 25 minutes laisse partir 3 offres.
      sendOffer: async () => {
        now += 10 * 60_000
      },
    })
    const summary = await scan.run()
    assert.equal(offers.length, 3)
    assert.equal(summary.pending, 1)
    assert.equal(seenIds(saved[0], 'a').length, 4, 'A1 connue + 3 envoyées')
  })

  it('abandonne la lecture des pages d\'une source après 3 échecs de suite, et envoie quand même ses offres', async () => {
    let reads = 0
    const describe = async () => {
      reads++
      throw new Error('délai dépassé')
    }
    const { scan, offers, digests } = await scanWith({ sources: [source('b', ['B1', 'B2', 'B3', 'B4', 'B5'].map((id) => offer(id)), { describe })] })
    await scan.run()
    assert.equal(reads, 3)
    assert.equal(offers.length, 5)
    assert.match(digests[0]?.text ?? '', /5 offre\(s\) envoyée\(s\) sans le détail de leur page \(lecture impossible, abandonnée après 3 échecs de suite\)/)
  })

  it('joint l\'avis officiel en PDF à l\'e-mail d\'un appel d\'offres, et l\'envoie sans lui si le téléchargement échoue (signalé)', async () => {
    const tender = (id: string) => offer(id, { kind: 'tender', noticePdfUrl: `https://www.boamp.fr/telechargements/FILES/PDF/2026/10/${id}.pdf` })
    const requested: string[] = []
    const readPdf = async (url: string, reference: string): Promise<EmailAttachment> => {
      requested.push(url)
      if (reference === 'T2') throw new Error('HTTP 404 sur https://www.boamp.fr/telechargements/FILES/PDF/2026/10/T2.pdf')
      return { filename: `avis-${reference}.pdf`, content: new TextEncoder().encode('%PDF-1.6'), contentType: 'application/pdf' }
    }
    const { scan, offers, digests } = await scanWith({ sources: [source('t', [tender('T1'), tender('T2'), offer('J1')], { kind: 'tender' })], readPdf })
    const summary = await scan.run()
    assert.deepEqual(summary.sent.map((l) => l.id), ['T1', 'T2', 'J1'], 'toutes envoyées')
    assert.deepEqual(requested, ['https://www.boamp.fr/telechargements/FILES/PDF/2026/10/T1.pdf', 'https://www.boamp.fr/telechargements/FILES/PDF/2026/10/T2.pdf'])
    assert.deepEqual(offers[0]?.attachments?.map((a) => a.filename), ['avis-T1.pdf'])
    assert.match(offers[0]?.text ?? '', /^Avis officiel \(PDF\) : joint à cet e-mail \(avis-T1\.pdf\)$/m)
    assert.equal(offers[1]?.attachments, undefined)
    assert.doesNotMatch(offers[1]?.text ?? '', /Avis officiel \(PDF\)/)
    assert.match(digests[0]?.text ?? '', /Source t : 1 offre\(s\) envoyée\(s\) sans l'avis officiel en PDF \(téléchargement impossible\)/)
  })

  it('ne télécharge pas l\'avis PDF d\'une offre échue, ni en essai', async () => {
    const outdated = offer('T1', { kind: 'tender', deadline: '2026-10-01', noticePdfUrl: 'https://ted.europa.eu/fr/notice/T1/pdf' })
    const { scan, offers, pdfRequests } = await scanWith({ sources: [source('t', [outdated])] })
    const summary = await scan.run()
    assert.equal(summary.outdated, 1)
    assert.equal(offers.length, 0)
    assert.deepEqual(pdfRequests, [])
    const trial = await scanWith({ sources: [source('t', [outdated])], dryRun: true })
    await trial.scan.run()
    assert.deepEqual(trial.pdfRequests, [])
  })

  it('renvoie aussitôt sans l\'avis PDF une offre dont le message est refusé avec lui (sinon refusée à chaque passage)', async () => {
    const pdf = { filename: 'avis-T1.pdf', content: new TextEncoder().encode('%PDF-1.6'), contentType: 'application/pdf' }
    const { scan, offers, digests, saved } = await scanWith({
      sources: [source('t', [offer('T1', { kind: 'tender', noticePdfUrl: 'https://www.boamp.fr/telechargements/FILES/PDF/2026/10/T1.pdf' })], { kind: 'tender' })],
      readPdf: async () => pdf,
      sendOffer: async (email) => {
        if (email.attachments?.length) throw Object.assign(new Error('Message failed: 552 pièce jointe refusée'), { code: 'EMESSAGE', responseCode: 552 })
      },
    })
    const summary = await scan.run()
    assert.deepEqual(summary.sent.map((l) => l.id), ['T1'], 'offre envoyée, sans erreur de passage')
    assert.equal(offers.length, 1)
    assert.equal(offers[0]?.attachments, undefined)
    assert.doesNotMatch(offers[0]?.text ?? '', /Avis officiel \(PDF\)/)
    assert.deepEqual(seenIds(saved[0], 't'), ['T1'])
    assert.match(digests[0]?.text ?? '', /Avis PDF refusé avec le message, offre envoyée sans lui : « Développeur fictif T1 » \(dinum, T1\) : Message failed: 552 pièce jointe refusée/)
  })

  it('continue de télécharger les avis PDF d\'une source après des avis introuvables (404) : seul un site injoignable arrête', async () => {
    const readPdf = async (url: string): Promise<EmailAttachment> => {
      throw new HttpError(`HTTP 404 sur ${url}`, 404)
    }
    const tenders = ['T1', 'T2', 'T3', 'T4'].map((id) => offer(id, { kind: 'tender', noticePdfUrl: `https://ted.europa.eu/fr/notice/${id}/pdf` }))
    const { scan, digests, pdfRequests } = await scanWith({ sources: [source('t', tenders, { kind: 'tender' })], readPdf })
    await scan.run()
    assert.equal(pdfRequests.length, 4)
    assert.match(digests[0]?.text ?? '', /4 offre\(s\) envoyée\(s\) sans l'avis officiel en PDF \(téléchargement impossible\)/)
  })

  it('abandonne le téléchargement des avis PDF d\'une source après 3 échecs de suite, et envoie quand même ses offres', async () => {
    let reads = 0
    const readPdf = async (): Promise<EmailAttachment> => {
      reads++
      throw new HttpError('https://ted.europa.eu/fr/notice/T1/pdf injoignable ou réponse interrompue (délai dépassé)')
    }
    const tenders = ['T1', 'T2', 'T3', 'T4'].map((id) => offer(id, { kind: 'tender', noticePdfUrl: `https://ted.europa.eu/fr/notice/${id}/pdf` }))
    const { scan, offers, digests } = await scanWith({ sources: [source('t', tenders, { kind: 'tender' })], readPdf })
    await scan.run()
    assert.equal(reads, 3)
    assert.equal(offers.length, 4)
    assert.match(digests[0]?.text ?? '', /4 offre\(s\) envoyée\(s\) sans l'avis officiel en PDF \(téléchargement impossible, abandonné après 3 échecs de suite\)/)
  })

  it('retient l\'état même si le récapitulatif ne part pas : les offres envoyées ne repartiront pas', async () => {
    const { scan, saved } = await scanWith({
      sources: [source('a', [offer('A2')])],
      sendDigest: async () => {
        throw new Error('SMTP indisponible')
      },
    })
    await assert.rejects(scan.run(), /récapitulatif non envoyé \(SMTP indisponible\)/)
    assert.deepEqual(seenIds(saved[0], 'a'), ['A1', 'A2'])
  })

  it('poursuit après une source en échec et la signale dans le récapitulatif', async () => {
    const { scan, digests } = await scanWith({ sources: [source('a', new Error('HTTP 503 sur https://exemple.test/flux')), source('b', [offer('B1')])] })
    const summary = await scan.run()
    assert.deepEqual(summary.sent.map((l) => l.id), ['B1'])
    assert.match(digests[0]?.text ?? '', /Source a : HTTP 503/)
  })

  it('passage de la journée sans point à vérifier : offres envoyées, état retenu, pas de récapitulatif', async () => {
    const { scan, calls } = await scanWith({ sources: [source('a', [offer('A2')])], digestMode: 'problems' })
    await scan.run()
    assert.deepEqual(calls, ['offre', 'état'])
  })

  it('passage de la journée avec un point à vérifier : le récapitulatif part', async () => {
    const { scan, digests } = await scanWith({ sources: [source('a', new Error('HTTP 503')), source('b', [offer('B1')])], digestMode: 'problems' })
    await scan.run()
    assert.equal(digests.length, 1)
    assert.match(digests[0]?.text ?? '', /Source a : HTTP 503/)
  })

  it('suit le mode de récapitulatif du passage planifié plutôt que celui de la configuration', async () => {
    const { scan, digests } = await scanWith({ sources: [source('a', [])], digestMode: 'always' })
    await scan.run({ digestMode: 'problems' })
    assert.equal(digests.length, 0, 'passage de la journée sans point à vérifier')
    const morning = await scanWith({ sources: [source('a', [])], digestMode: 'problems' })
    await morning.scan.run({ digestMode: 'always' })
    assert.equal(morning.digests.length, 1, 'passage de 5 h : toujours')
  })

  it('signale dans le récapitulatif une copie du jour de l\'état impossible', async () => {
    const { scan, digests } = await scanWith({ sources: [source('a', [offer('A2')])], stateWarning: "Copie du jour de l'état impossible (disque plein)" })
    await scan.run()
    assert.match(digests[0]?.text ?? '', /Fichier d'état : Copie du jour de l'état impossible \(disque plein\)/)
  })

  it('en essai, n\'envoie rien et ne retient rien', async () => {
    const { scan, calls } = await scanWith({ sources: [source('a', [offer('A2')])], dryRun: true })
    await scan.run()
    assert.deepEqual(calls, [])
  })
})
