// Lecture et écriture du fichier d'état (annonces déjà vues). En production, ce fichier vit sur la branche Git
// `veille-etat`, que le workflow GitHub récupère avant le passage et pousse après (voir README).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '../config.js'
import { EMPTY_STATE, veilleStateSchema, type VeilleState } from './run-state.js'

/** Clés triées : le fichier est versionné, des clés stables donnent des différences lisibles d'un jour à l'autre. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, sortKeys(nested)]),
    )
  }
  return value
}

@Injectable()
export class StateStore {
  private readonly logger = new Logger(StateStore.name)

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async load(): Promise<VeilleState> {
    let raw: string
    try {
      raw = await readFile(this.config.stateFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.logger.log(`Pas encore de fichier d'état (${this.config.stateFile}) : chaque source sera lue pour la première fois.`)
      return EMPTY_STATE
    }
    // Un état illisible arrête la veille : repartir de zéro en silence ferait oublier toutes les annonces vues.
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch (error) {
      throw new Error(`Fichier d'état ${this.config.stateFile} illisible (${(error as Error).message}). Corrigez-le, ou supprimez-le pour repartir de zéro.`)
    }
    const parsed = veilleStateSchema.safeParse(json)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const where = issue?.path.length ? `${issue.path.join('.')} : ` : ''
      throw new Error(`Fichier d'état ${this.config.stateFile} invalide (${where}${issue?.message}). Corrigez-le, ou supprimez-le pour repartir de zéro.`)
    }
    return parsed.data
  }

  async save(state: VeilleState): Promise<void> {
    await mkdir(dirname(this.config.stateFile), { recursive: true })
    // Écriture dans un fichier temporaire puis renommage : un arrêt brutal ne laisse jamais un état à moitié écrit.
    const temporary = `${this.config.stateFile}.tmp`
    await writeFile(temporary, `${JSON.stringify(sortKeys(state), null, 2)}\n`, 'utf8')
    await rename(temporary, this.config.stateFile)
  }
}
