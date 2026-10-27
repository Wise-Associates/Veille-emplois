import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig } from '../config.js'
import { EMPTY_STATE, type VeilleState } from './run-state.js'
import { StateStore } from './state-store.js'

const storeIn = async (file = 'etat/etat.json') => {
  const dir = await mkdtemp(join(tmpdir(), 'veille-etat-'))
  const config: AppConfig = { stateFile: join(dir, file), dryRun: false, maxOfferEmailsPerRun: 200, digestMode: 'always', mail: null, settings: null }
  return { store: new StateStore(config), path: config.stateFile }
}

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
})
