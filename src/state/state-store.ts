// Lecture et écriture du fichier d'état (annonces déjà vues). Sur le VPS, il vit dans un dossier du serveur monté dans
// le conteneur (ADR 0010) ; avec l'ancien workflow GitHub, sur la branche Git `veille-etat` (voir README).

import { copyFile, link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { CLOCK, type Clock } from '../clock.js'
import { APP_CONFIG, type AppConfig } from '../config.js'
import { addDays, frenchDeadline, parisDay } from '../dates.js'
import { EMPTY_STATE, veilleStateSchema, type VeilleState } from './run-state.js'

/**
 * Copies quotidiennes gardées dans `historique/`, à côté du fichier : elles remplacent l'historique de la branche Git
 * (revenir à l'état d'un jour précis, après un passage qui l'aurait abîmé).
 */
export const HISTORY_DAYS = 30
/**
 * Au-delà, un verrou est tenu pour abandonné (processus arrêté net : conteneur tué, panne du serveur). Un passage dure
 * moins d'une heure : 25 minutes d'envoi au plus, puis 15 minutes au plus de lecture de la boîte AO.
 */
export const STALE_LOCK_MS = 2 * 60 * 60_000

/** Un passage tient déjà le verrou : celui-ci n'est pas lancé (rien n'est lu ni envoyé). */
export class RunInProgressError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunInProgressError'
  }
}

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

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

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

  /**
   * Enregistre l'état, puis sa copie du jour. `warning` : copie du jour impossible (l'état, lui, est enregistré) ; à
   * signaler dans le récapitulatif, sans arrêter le passage.
   */
  async save(state: VeilleState): Promise<{ warning: string | null }> {
    await mkdir(dirname(this.config.stateFile), { recursive: true })
    // Écriture dans un fichier temporaire puis renommage : un arrêt brutal ne laisse jamais un état à moitié écrit.
    const temporary = `${this.config.stateFile}.tmp`
    await writeFile(temporary, `${JSON.stringify(sortKeys(state), null, 2)}\n`, 'utf8')
    await rename(temporary, this.config.stateFile)
    try {
      await this.keepDailyCopy()
      return { warning: null }
    } catch (error) {
      const warning = `Copie du jour de l'état impossible (${(error as Error).message}) : l'état est enregistré, mais l'historique n'est pas tenu.`
      this.logger.error(warning)
      return { warning }
    }
  }

  /**
   * Verrou d'un passage complet (fichier `<état>.lock`, créé seulement s'il n'existe pas) : un passage lancé à la main
   * pendant un passage planifié est refusé (RunInProgressError) au lieu de renvoyer les mêmes offres et d'écraser l'état
   * de l'autre. Rend la fonction qui le libère. Un verrou de plus de deux heures, ou daté dans le futur, est abandonné et
   * repris.
   */
  async acquireRunLock(): Promise<() => Promise<void>> {
    const path = this.lockPath()
    const now = this.clock.now()
    const content = JSON.stringify({ since: now.toISOString(), pid: process.pid })
    await mkdir(dirname(path), { recursive: true })
    // Contenu écrit à part, puis mis en place d'un seul coup : un autre passage ne lit jamais un verrou vide (qu'il
    // prendrait pour abandonné). link échoue si le verrou existe ; rename remplace d'un coup un verrou abandonné.
    const temporary = `${path}.${process.pid}.${now.getTime()}.tmp`
    await writeFile(temporary, content)
    try {
      await link(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        await rm(temporary, { force: true })
        throw error
      }
      const since = await this.lockDate(path)
      if (since && since.getTime() <= now.getTime() && now.getTime() - since.getTime() < STALE_LOCK_MS) {
        await rm(temporary, { force: true })
        throw new RunInProgressError(`Un passage est déjà en cours (commencé le ${frenchDeadline(since.toISOString())}) : celui-ci n'est pas lancé.`)
      }
      // Deux passages qui reprendraient le même verrou abandonné au même instant : cas négligé (après une panne, un
      // passage planifié et un passage manuel lancés ensemble).
      this.logger.warn(`Verrou abandonné (${since ? `posé le ${frenchDeadline(since.toISOString())}` : 'illisible'}) : repris par ce passage.`)
      await rename(temporary, path)
    }
    await rm(temporary, { force: true })
    return async () => {
      // Verrou repris entre-temps par un autre passage (celui-ci aurait duré plus de deux heures) : laissé en place.
      const current = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (current === content) await rm(path, { force: true })
      else this.logger.warn('Verrou du passage déjà repris par un autre passage : laissé en place.')
    }
  }

  /**
   * Verrou laissé par un passage interrompu, retiré au démarrage du conteneur planifié : aucun passage ne survit à un
   * redémarrage du conteneur (ceux lancés par « docker exec » s'arrêtent avec lui). Sans cela, les passages planifiés
   * des deux heures suivantes seraient refusés. Rend la date de pose du verrou retiré (null s'il était illisible), ou
   * undefined s'il n'y en avait pas.
   */
  async clearLeftoverLock(): Promise<Date | null | undefined> {
    const path = this.lockPath()
    const since = await readFile(path, 'utf8').then(
      () => this.lockDate(path),
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      },
    )
    if (since !== undefined) await rm(path, { force: true })
    return since
  }

  private lockPath(): string {
    return `${this.config.stateFile}.lock`
  }

  /** Date de pose d'un verrou existant ; null s'il est illisible (alors tenu pour abandonné). */
  private async lockDate(path: string): Promise<Date | null> {
    try {
      const { since } = JSON.parse(await readFile(path, 'utf8')) as { since?: unknown }
      const date = typeof since === 'string' ? new Date(since) : null
      return date && !Number.isNaN(date.getTime()) ? date : null
    } catch {
      // Verrou vide ou abîmé (arrêt pendant son écriture) : traité comme abandonné, ce qui est journalisé par l'appelant.
      return null
    }
  }

  /** Copie de l'état du jour (heure de Paris) dans `historique/`, et suppression des copies de plus de HISTORY_DAYS. */
  private async keepDailyCopy(): Promise<void> {
    const directory = join(dirname(this.config.stateFile), 'historique')
    const name = basename(this.config.stateFile, extname(this.config.stateFile))
    const today = parisDay(this.clock.now())
    await mkdir(directory, { recursive: true })
    await copyFile(this.config.stateFile, join(directory, `${name}-${today}.json`))
    const oldest = addDays(today, -HISTORY_DAYS)
    const pattern = new RegExp(`^${name.replace(/[^\w-]/g, '\\$&')}-(\\d{4}-\\d{2}-\\d{2})\\.json$`)
    for (const file of await readdir(directory)) {
      const day = pattern.exec(file)?.[1]
      if (day && day < oldest) await rm(join(directory, file))
    }
  }
}
