import { Inject, Injectable, Logger } from '@nestjs/common'
import { z } from 'zod'
import { APP_CONFIG, type AppConfig } from '../config.js'
import { HttpClient } from '../http/http-client.js'
import { DEFAULT_SETTINGS } from './defaults.js'
import { chooseSettings, type ChosenSettings, type RemoteSettings, type SettingsSnapshot } from './veille-settings.js'

/** Réponse de GET /api/veille/config de MyBestConsultant ; les réglages eux-mêmes sont validés par chooseSettings. */
const responseSchema = z.object({ version: z.number().int().positive(), savedAt: z.string(), config: z.unknown() })

/**
 * Réglages d'un passage : lus dans MyBestConsultant, sinon la dernière version connue, sinon ceux du dépôt
 * (chooseSettings). Ne lève jamais d'erreur : une lecture impossible devient un avertissement du récapitulatif.
 */
@Injectable()
export class SettingsLoader {
  private readonly logger = new Logger(SettingsLoader.name)

  constructor(
    private readonly http: HttpClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async load(snapshot: SettingsSnapshot | undefined): Promise<ChosenSettings> {
    const chosen = chooseSettings({ remote: await this.fetchRemote(), snapshot, defaults: DEFAULT_SETTINGS })
    const version = chosen.origin === 'defaults' ? 'ceux du dépôt' : `version ${chosen.snapshot?.version}`
    this.logger.log(`Réglages : ${version} (${chosen.origin === 'remote' ? 'MyBestConsultant' : chosen.origin === 'snapshot' ? 'dernière version connue' : 'config/defaults.json'}).`)
    if (chosen.warning) this.logger.warn(chosen.warning)
    return chosen
  }

  private async fetchRemote(): Promise<RemoteSettings> {
    const remote = this.config.settings
    if (!remote) return null
    try {
      // Délai court, une nouvelle tentative (HttpClient) : MyBestConsultant indisponible ne doit pas retarder le passage.
      const body = await this.http.json(remote.url, responseSchema, { headers: { Authorization: `Bearer ${remote.token}` }, timeoutMs: 15_000 })
      return { ok: true, version: body.version, savedAt: body.savedAt, value: body.config }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
