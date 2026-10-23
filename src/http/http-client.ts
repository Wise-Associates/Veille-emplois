// Accès HTTP commun à toutes les sources : délai maximal, taille maximale, une nouvelle tentative sur les pannes
// passagères, et un User-Agent qui dit qui lit (les sites peuvent ainsi nous identifier ; on ne se fait jamais passer
// pour un navigateur).

import { setTimeout as sleep } from 'node:timers/promises'
import { Injectable, Logger } from '@nestjs/common'
import type { z } from 'zod'

const USER_AGENT = 'veille-marches-emplois/1.0 (Wise Associates)'
/** Le flux de la DGFiP sur Choisir le service public met une quinzaine de secondes à arriver. */
const DEFAULT_TIMEOUT_MS = 60_000
const RETRY_DELAY_MS = 5_000
/**
 * Taille maximale d'une réponse, une fois décompressée. La plus grosse observée (flux DGFiP) fait 1,4 Mo ; la limite
 * empêche une réponse aberrante (ou une « bombe » de compression) d'épuiser la mémoire et d'arrêter tout le passage.
 */
const MAX_BODY_BYTES = 20 * 1024 * 1024

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'HEAD'
  headers?: Record<string, string>
  /** Corps JSON (envoyé avec Content-Type: application/json). */
  json?: unknown
  timeoutMs?: number
  /** Nouvelle tentative sur une panne passagère (par défaut oui). */
  retry?: boolean
}

/**
 * Lecture de la page d'une offre au moment de l'envoyer : délai court et sans nouvelle tentative, car elle se répète
 * pour des centaines d'offres et un site lent ferait dépasser la durée maximale du passage. Un échec n'empêche pas
 * l'envoi de l'offre (il est signalé).
 */
export const OFFER_PAGE_REQUEST: RequestOptions = { timeoutMs: 15_000, retry: false }

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

interface HttpResponse {
  headers: Headers
  body: Uint8Array
}

/** Adresse sans la requête : les paramètres peuvent être longs (BOAMP) et n'aident pas au diagnostic. */
function describe(url: string): string {
  const parsed = new URL(url)
  return `${parsed.origin}${parsed.pathname}`
}

/** fetch ne dit que « fetch failed » : la vraie cause (DNS, connexion refusée, TLS…) est dans `cause`. */
function networkReason(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'délai dépassé'
  const cause = error instanceof Error ? (error.cause as { code?: string; message?: string } | undefined) : undefined
  const detail = cause?.code ?? cause?.message
  return [error instanceof Error ? error.message : String(error), detail].filter(Boolean).join(' : ')
}

function isTransient(status: number): boolean {
  return status === 429 || status >= 500
}

async function readCapped(response: Response, url: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      await response.body?.cancel()
      throw new HttpError(`Réponse de ${describe(url)} trop volumineuse (plus de ${MAX_BODY_BYTES / 1024 / 1024} Mo).`, 413)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

@Injectable()
export class HttpClient {
  private readonly logger = new Logger(HttpClient.name)

  async text(url: string, options: RequestOptions & { encoding?: 'utf-8' | 'latin1' } = {}): Promise<string> {
    // En-tête Accept standard : sans lui, la protection du site de La Banque Postale refuse ses pages d'offres
    // (User-Agent inchangé : on ne se fait pas passer pour un navigateur).
    const headers = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...options.headers }
    const { body } = await this.request(url, { ...options, headers })
    return new TextDecoder(options.encoding ?? 'utf-8').decode(body)
  }

  async json<T>(url: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
    const { body } = await this.request(url, { ...options, headers: { Accept: 'application/json', ...options.headers } })
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(body))
    } catch (error) {
      throw new HttpError(`Réponse non JSON de ${describe(url)} : ${(error as Error).message}`)
    }
    const result = schema.safeParse(parsed)
    if (!result.success) {
      const issues = result.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.')} : ${issue.message}`)
      throw new HttpError(`Réponse inattendue de ${describe(url)} (le format a peut-être changé) — ${issues.join(' ; ')}`)
    }
    return result.data
  }

  async head(url: string): Promise<Headers> {
    return (await this.request(url, { method: 'HEAD' })).headers
  }

  private async request(url: string, options: RequestOptions): Promise<HttpResponse> {
    try {
      return await this.attempt(url, options)
    } catch (error) {
      if (options.retry === false) throw error
      if (!(error instanceof HttpError) || (error.status !== undefined && !isTransient(error.status))) throw error
      this.logger.warn(`${error.message} — nouvelle tentative dans ${RETRY_DELAY_MS / 1000} s`)
      await sleep(RETRY_DELAY_MS)
      return this.attempt(url, options)
    }
  }

  /** Une requête complète, corps compris : le délai et la nouvelle tentative couvrent aussi la lecture du corps. */
  private async attempt(url: string, options: RequestOptions): Promise<HttpResponse> {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'fr-FR,fr;q=0.9',
      ...options.headers,
    }
    if (options.json !== undefined) headers['Content-Type'] = 'application/json'
    try {
      const response = await fetch(url, {
        method: options.method ?? (options.json !== undefined ? 'POST' : 'GET'),
        headers,
        body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        redirect: 'follow',
      })
      if (!response.ok) {
        // Corps lu et jeté pour libérer la connexion.
        await response.body?.cancel()
        throw new HttpError(`HTTP ${response.status} sur ${describe(url)}`, response.status)
      }
      return { headers: response.headers, body: await readCapped(response, url) }
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(`${describe(url)} injoignable ou réponse interrompue (${networkReason(error)})`)
    }
  }
}
