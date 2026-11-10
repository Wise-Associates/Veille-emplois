// Envoi du rapport d'un passage à MyBestConsultant (POST /api/veille/runs, ADR 0012), à côté de la route des réglages
// et avec le même jeton (VEILLE_CONFIG_TOKEN) : aucune variable de plus. Le suivi des sources n'est qu'un affichage :
// un envoi impossible devient un point à vérifier du récapitulatif, jamais l'échec du passage.

import { Inject, Injectable } from '@nestjs/common'
import { z } from 'zod'
import { APP_CONFIG, type AppConfig } from '../config.js'
import { HttpClient } from '../http/http-client.js'
import type { RunReportPayload } from './source-report.js'

/** MyBestConsultant répond { ok: true }, que le rapport soit nouveau ou déjà reçu (même passage renvoyé). */
const ackSchema = z.object({ ok: z.literal(true) })

/**
 * Adresse des rapports, tirée de celle des réglages (…/api/veille/config → …/api/veille/runs) ; erreur si
 * VEILLE_CONFIG_URL ne finit pas par /config.
 */
export function reportUrl(settingsUrl: string): string {
  const url = new URL(settingsUrl)
  const path = url.pathname.replace(/\/config\/?$/, '/runs')
  if (path === url.pathname) throw new Error('VEILLE_CONFIG_URL ne finit pas par /config : adresse des rapports de passage inconnue')
  url.pathname = path
  url.search = ''
  return url.href
}

@Injectable()
export class SourceReportSender {
  constructor(
    private readonly http: HttpClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** false : MyBestConsultant n'est pas configuré (VEILLE_CONFIG_URL), rien n'est envoyé. Lève une erreur sinon. */
  async send(report: RunReportPayload): Promise<boolean> {
    const target = this.config.settings
    if (!target) return false
    const url = reportUrl(target.url)
    const { origin } = new URL(url)
    // Une nouvelle tentative sur une panne passagère (HttpClient) : sans risque, MyBestConsultant ignore un passage déjà reçu.
    await this.http.json(url, ackSchema, {
      json: report,
      headers: { Authorization: `Bearer ${target.token}` },
      timeoutMs: 15_000,
      // Le jeton n'est envoyé qu'à l'origine configurée (voir SettingsLoader).
      allowRedirect: (next) => next.origin === origin,
    })
    return true
  }
}
