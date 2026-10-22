// Offres de l'Autorité de la concurrence sur son site de recrutement (Beetween), lues par l'API JSON qu'utilise
// la page elle-même. Ces offres (stages notamment) ne sont pas toutes sur Choisir le service public.

import { z } from 'zod'
import type { HttpClient } from '../http/http-client.js'
import type { Listing, ListingSource, SourceBatch } from '../listing.js'

const LIST_URL = 'https://autoritedelaconcurrence.nos-recrutements.fr/api/job/list'
const PAGE_SIZE = 100
const MAX_PAGES = 5

const jobSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string(),
  url: z.string(),
  creationDate: z.string().nullish(),
  city: z.string().nullish(),
  contractType: z.string().nullish(),
})
const responseSchema = z.object({ numFound: z.number().int(), jobs: z.array(jobSchema) })

export type BeetweenJob = z.infer<typeof jobSchema>

const SITE_HOST = new URL(LIST_URL).hostname

export function beetweenJobToListing(job: BeetweenJob): Listing {
  // Le récapitulatif présente ce lien comme une offre de l'Autorité : jamais vers un autre site.
  const host = URL.canParse(job.url) ? new URL(job.url).hostname : null
  if (host !== SITE_HOST) throw new Error(`Lien d'offre inattendu (${host ?? 'absent'}) : l'API a peut-être changé.`)
  return {
    kind: 'job',
    id: job.id,
    organisationId: 'autorite-concurrence',
    title: job.title.trim(),
    url: job.url,
    publishedOn: job.creationDate?.match(/^\d{4}-\d{2}-\d{2}/)?.[0],
    location: job.city ?? undefined,
    details: job.contractType ? [job.contractType] : [],
  }
}

export class AutoriteConcurrenceSource implements ListingSource {
  readonly id = 'autorite-concurrence-carrieres'
  readonly label = 'Autorité de la concurrence — site de recrutement'
  readonly kind = 'job'

  constructor(private readonly http: HttpClient) {}

  async fetch(): Promise<SourceBatch> {
    const jobs: BeetweenJob[] = []
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) throw new Error(`Plus de ${MAX_PAGES * PAGE_SIZE} offres : lecture à vérifier.`)
      const body = { keywords: '', locations: [], contractTypes: [], categories: [], page, rows: PAGE_SIZE }
      const response = await this.http.json(LIST_URL, responseSchema, { json: body })
      jobs.push(...response.jobs)
      if (jobs.length >= response.numFound) break
      if (response.jobs.length === 0) throw new Error(`Page vide après ${jobs.length} offres sur ${response.numFound} annoncées.`)
    }
    return { listings: jobs.map(beetweenJobToListing), ignoredIds: [] }
  }
}
