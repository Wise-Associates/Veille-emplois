import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig } from '../config.js'
import { EMPTY_STATE, type VeilleState } from './run-state.js'
import { RunInProgressError, StateStore } from './state-store.js'

const storeIn = async (file = 'etat/etat.json', clock = { now: () => new Date('2026-11-05T05:00:00Z') }) => {
  const dir = await mkdtemp(join(tmpdir(), 'veille-etat-'))
  const config: AppConfig = { stateFile: join(dir, file), dryRun: false, maxOfferEmailsPerRun: 200, digestMode: 'always', mail: null, settings: null, aoSync: null }
  return { store: new StateStore(config, clock), path: config.stateFile, dir }
}

const state: VeilleState = { version: 1, sources: { ted: { seen: { a: '2026-11-05' }, lastCount: 1, lastSuccessOn: '2026-11-05' } }, procedures: {} }

describe('fichier d\'état', () => {
  it('part d\'un état vide quand le fichier n\'existe pas encore', async () => {
    const { store } = await storeIn()
    assert.deepEqual(await store.load(), EMPTY_STATE)
  })

  it('refuse un fichier abîmé au lieu de repartir de zéro en silence', async () => {
    const { store, path } = await storeIn('etat.json')
    await writeFile(path, '{ "version": 1, "sources": ')
    await assert.rejects(store.load(), /illisible/)
    await writeFile(path, JSON.stringify({ version: 2, sources: {}, procedures: {} }))
    await assert.rejects(store.load(), /invalide/)
  })

  it('enregistre un état relu à l\'identique, avec des clés triées', async () => {
    const { store, path } = await storeIn()
    const state: VeilleState = {
      version: 1,
      sources: { ted: { seen: { b: '2026-10-22', a: '2026-10-21' }, lastCount: 2, lastSuccessOn: '2026-10-22' } },
      procedures: {},
    }
    await store.save(state)
    assert.deepEqual(await store.load(), state)
    const raw = await readFile(path, 'utf8')
    assert.ok(raw.indexOf('"a"') < raw.indexOf('"b"'))
  })

  it('garde une copie de l\'état par jour (heure de Paris) pendant 30 jours, sans toucher aux autres fichiers', async () => {
    const { store, path, dir } = await storeIn('etat.json')
    const history = join(dir, 'historique')
    await mkdir(history)
    for (const name of ['etat-2026-10-05.json', 'etat-2026-10-06.json', 'note.txt']) await writeFile(join(history, name), '{}')
    assert.equal((await store.save(state)).warning, null)
    assert.deepEqual((await readdir(history)).sort(), ['etat-2026-10-06.json', 'etat-2026-11-05.json', 'note.txt'], 'au-delà de 30 jours : supprimée')
    assert.equal(await readFile(join(history, 'etat-2026-11-05.json'), 'utf8'), await readFile(path, 'utf8'))
  })

  it('signale une copie du jour impossible sans perdre l\'état enregistré', async () => {
    const { store, path, dir } = await storeIn('etat.json')
    await writeFile(join(dir, 'historique'), 'un fichier à la place du dossier')
    const { warning } = await store.save(state)
    assert.match(warning ?? '', /Copie du jour de l'état impossible/)
    assert.deepEqual(await store.load(), state)
    assert.ok((await readFile(path, 'utf8')).includes('"ted"'))
  })

  it('refuse un second passage tant que le premier tient le verrou, puis le laisse partir', async () => {
    const { store } = await storeIn()
    const release = await store.acquireRunLock()
    await assert.rejects(store.acquireRunLock(), (error: Error) => error instanceof RunInProgressError && /déjà en cours \(commencé le 05\/11\/2026 à 06:00\)/.test(error.message))
    await release()
    const again = await store.acquireRunLock()
    await again()
  })

  it('reprend un verrou abandonné (passage arrêté net il y a plus de deux heures)', async () => {
    let now = new Date('2026-11-05T05:00:00Z')
    const { store } = await storeIn('etat.json', { now: () => now })
    await store.acquireRunLock()
    now = new Date('2026-11-05T07:01:00Z')
    const release = await store.acquireRunLock()
    await release()
  })

  it('ne retire pas un verrou qui n\'est plus le sien', async () => {
    let now = new Date('2026-11-05T05:00:00Z')
    const { store, path } = await storeIn('etat.json', { now: () => now })
    const first = await store.acquireRunLock()
    now = new Date('2026-11-05T07:01:00Z')
    await store.acquireRunLock()
    await first()
    await assert.rejects(store.acquireRunLock(), RunInProgressError, 'le verrou du second passage est resté en place')
    assert.ok((await readFile(`${path}.lock`, 'utf8')).includes('2026-11-05T07:01:00.000Z'))
  })

  it('ne laisse passer qu\'un passage sur deux lancés au même instant', async () => {
    const { store } = await storeIn()
    const results = await Promise.allSettled([store.acquireRunLock(), store.acquireRunLock(), store.acquireRunLock()])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.ok(results.every((result) => result.status === 'fulfilled' || result.reason instanceof RunInProgressError))
  })

  it('tient pour abandonné un verrou daté dans le futur (il bloquerait sinon tout passage et tout déploiement)', async () => {
    const { store, path } = await storeIn('etat.json')
    await writeFile(`${path}.lock`, JSON.stringify({ since: '2099-01-01T00:00:00.000Z', pid: 1 }))
    const release = await store.acquireRunLock()
    await release()
  })

  it('retire au démarrage le verrou laissé par un passage interrompu, et dit quand il avait été posé', async () => {
    const { store, path } = await storeIn('etat.json')
    assert.equal(await store.clearLeftoverLock(), undefined, 'pas de verrou')
    await store.acquireRunLock()
    assert.deepEqual(await store.clearLeftoverLock(), new Date('2026-11-05T05:00:00Z'))
    await writeFile(`${path}.lock`, '')
    assert.equal(await store.clearLeftoverLock(), null, 'verrou illisible : retiré aussi')
    const release = await store.acquireRunLock()
    await release()
    assert.deepEqual((await readdir(join(path, '..'))).filter((name) => name.includes('.lock')), [], 'aucun fichier temporaire laissé')
  })
})
