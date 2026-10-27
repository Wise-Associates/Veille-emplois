// Réglages de la veille : organismes suivis et règles qui reconnaissent leurs appels d'offres, sources lues, périmètre
// informatique (ADR 0005). Modifiés dans l'admin de MyBestConsultant (/admin/veille), lus au début de chaque passage
// (settings-loader.ts) ; par défaut, ceux du dépôt (config/defaults.json). Même format que MyBestConsultant
// (src/lib/veille/config.ts, même `schemaVersion`) : toute évolution se fait dans les deux projets. Règles pures,
// testées dans veille-settings.spec.ts.

import { z } from 'zod'
import { normalizePhrase } from '../phrases.js'

export const SCHEMA_VERSION = 1

/** Sites lus par un code propre au scanner (sources.ts), et l'organisme dont ils publient les offres. */
export const BUILTIN_SOURCE_ORGANISATIONS = {
  'autorite-concurrence-carrieres': 'autorite-concurrence',
  'banque-postale-carrieres': 'banque-postale',
  'afd-carrieres': 'proparco',
  'crh-site': 'crh',
} as const
export type BuiltinSourceId = keyof typeof BUILTIN_SOURCE_ORGANISATIONS
const BUILTIN_IDS = Object.keys(BUILTIN_SOURCE_ORGANISATIONS) as [BuiltinSourceId, ...BuiltinSourceId[]]

/** Liste saisie : espaces retirés, valeurs vides et doublons ignorés. */
const list = <T extends z.ZodType>(item: T, max: number) =>
  z.preprocess(
    (value) => (Array.isArray(value) ? [...new Set(value.map((v) => (typeof v === 'string' ? v.trim() : v)).filter((v) => v !== ''))] : value),
    z.array(item).max(max),
  )
/** Clé du fichier d'état : jamais modifiée après création. */
const Key = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])$/, 'identifiant invalide')
/**
 * Expression mise sous sa forme comparée dès la validation (normalizePhrase : seulement `[a-z0-9 *]`) : elle peut entrer
 * telle quelle dans une requête BOAMP ou TED et dans une expression régulière.
 */
const Phrase = z.string().max(120).transform(normalizePhrase).refine((p) => p !== '', 'expression vide une fois accents et ponctuation retirés')
const Label = z.string().trim().min(1).max(120)

/**
 * Adresse saisie dans les réglages (flux d'un site carrières) et chaque redirection qui en part : https, nom de domaine
 * public (ni adresse IP, ni localhost), sans identifiants. Empêche un flux de faire lire au scanner une adresse
 * interne de la machine qui l'exécute (GitHub Actions ou poste local).
 */
export function isPublicHttpsUrl(value: string | URL): boolean {
  const url = typeof value === 'string' ? (URL.canParse(value) ? new URL(value) : null) : value
  return !!url && url.protocol === 'https:' && !url.username && !url.password && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(url.hostname)
}
const FeedUrl = z.string().trim().max(500).refine((value) => isPublicHttpsUrl(value), 'adresse de flux en https:// sur un nom de domaine public attendue')

const TenderRule = z
  .object({
    sirens: list(z.string().regex(/^\d{9}$/, 'SIREN à 9 chiffres'), 20),
    names: list(Phrase, 40),
    excludedNames: list(Phrase, 40),
    requiredText: list(Phrase, 20),
    /** Raison de la règle, pour les humains ; sans effet. */
    note: z.string().trim().max(300).default(''),
  })
  .refine((r) => r.sirens.length + r.names.length > 0, 'règle sans SIREN ni nom')

const Acronym = z.string().regex(/^[A-Z0-9]{2,10}$/, 'sigle en majuscules')

/** Famille de mots-clés des appels d'offres (« SaaS, logiciels », « Gouvernance des données »…) : une recherche par famille. */
const KeywordFamily = z
  .object({ id: Key, label: Label, phrases: list(Phrase, 200), acronyms: list(Acronym, 50) })
  .refine((f) => f.phrases.length + f.acronyms.length > 0, 'famille sans mot-clé')

/**
 * Mots-clés des appels d'offres (décision du 2026-10-27, ADR 0006). Absents des réglages enregistrés avant cette date :
 * recherche limitée aux organismes suivis, sans mot-clé.
 */
const TenderKeywords = z
  .object({
    /** Chercher aussi les avis des acheteurs non suivis (BOAMP et TED), par mots-clés et classification informatique. */
    allBuyers: z.boolean(),
    families: z.array(KeywordFamily).max(30),
    /** « Infrastructure seule » : écartent un avis classé informatique dont l'intitulé en parle sans aucun mot-clé. */
    infrastructurePhrases: list(Phrase, 200),
  })
  .default({ allBuyers: false, families: [], infrastructurePhrases: [] })

const Source = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('boamp'), id: z.literal('boamp'), enabled: z.boolean() }),
  z.object({ kind: z.literal('ted'), id: z.literal('ted'), enabled: z.boolean() }),
  z.object({ kind: z.literal('builtin'), id: z.enum(BUILTIN_IDS), enabled: z.boolean() }),
  z.object({
    kind: z.literal('csp'), id: Key, enabled: z.boolean(), organisationId: Key, label: Label,
    codes: list(z.string().regex(/^\d{1,8}$/), 10).refine((c) => c.length > 0, 'au moins un code d\'organisme'),
  }),
  z.object({ kind: z.literal('rss'), id: Key, enabled: z.boolean(), organisationId: Key, label: Label, url: FeedUrl, readOfferPage: z.boolean() }),
])

const SettingsSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    organisations: z.array(z.object({ id: Key, name: z.string().trim().min(1).max(80), enabled: z.boolean(), tenderRules: z.array(TenderRule).max(10) })).min(1).max(100),
    sources: z.array(Source).max(200),
    itScope: z.object({
      enabled: z.boolean(),
      cpvPrefixes: list(z.string().regex(/^\d{1,8}$/), 50),
      // Sans guillemet ni barre oblique inverse : les descripteurs entrent dans la requête BOAMP de tous les acheteurs.
      boampDescriptors: list(z.string().max(120).regex(/^[^"\\]+$/, 'descripteur sans guillemet ni \\'), 50),
      phrases: list(Phrase, 1000),
      acronyms: list(Acronym, 200),
      exclusionPhrases: list(Phrase, 200),
    }),
    tenderKeywords: TenderKeywords,
  })
  .superRefine((settings, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
    const duplicates = (ids: string[]) => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
    for (const id of duplicates(settings.organisations.map((o) => o.id))) fail(`organisme « ${id} » en double`)
    for (const id of duplicates(settings.sources.map((s) => s.id))) fail(`source « ${id} » en double`)
    for (const id of duplicates(settings.tenderKeywords.families.map((f) => f.id))) fail(`famille de mots-clés « ${id} » en double`)
    const organisations = new Set(settings.organisations.map((o) => o.id))
    for (const source of settings.sources) {
      const organisationId = source.kind === 'builtin' ? BUILTIN_SOURCE_ORGANISATIONS[source.id] : 'organisationId' in source ? source.organisationId : null
      if (organisationId && !organisations.has(organisationId)) fail(`source « ${source.id} » : organisme « ${organisationId} » inconnu`)
    }
  })

export type VeilleSettings = z.infer<typeof SettingsSchema>
export type SourceSettings = VeilleSettings['sources'][number]
export type ItScopeSettings = VeilleSettings['itScope']
export type TenderKeywordSettings = VeilleSettings['tenderKeywords']

export function parseVeilleSettings(input: unknown): { success: true; settings: VeilleSettings } | { success: false; error: string } {
  const parsed = SettingsSchema.safeParse(input)
  if (parsed.success) return { success: true, settings: parsed.data }
  const error = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || 'réglages'} : ${issue.message}`)
    .join(' ; ')
  return { success: false, error }
}

/** Dernière version lue dans MyBestConsultant, gardée dans le fichier d'état pour un passage où il ne répond pas. */
export interface SettingsSnapshot {
  version: number
  savedAt: string
  value: unknown
}

/** Lecture des réglages dans MyBestConsultant : null si elle n'est pas configurée (VEILLE_CONFIG_URL absente). */
export type RemoteSettings = { ok: true; version: number; savedAt: string; value: unknown } | { ok: false; error: string } | null

export interface ChosenSettings {
  settings: VeilleSettings
  origin: 'remote' | 'snapshot' | 'defaults'
  /** Pour le récapitulatif (« points à vérifier ») : réglages de MyBestConsultant non utilisés. */
  warning: string | null
  /** Dernière version connue à garder dans le fichier d'état. */
  snapshot: SettingsSnapshot | undefined
}

const frenchDay = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/')

/**
 * Réglages d'un passage (décision du 2026-10-27) : ceux de MyBestConsultant ; s'il ne répond pas ou renvoie des
 * réglages illisibles, la dernière version connue (fichier d'état) ; à défaut, ceux du dépôt. Les deux replis sont
 * signalés dans le récapitulatif : la veille ne s'arrête pas parce que le site est indisponible.
 */
export function chooseSettings(input: { remote: RemoteSettings; snapshot: SettingsSnapshot | undefined; defaults: VeilleSettings }): ChosenSettings {
  const { remote, snapshot, defaults } = input
  if (remote === null) {
    return { settings: defaults, origin: 'defaults', warning: 'VEILLE_CONFIG_URL non défini : réglages du dépôt (config/defaults.json) utilisés.', snapshot }
  }
  let problem: string
  if (remote.ok) {
    const parsed = parseVeilleSettings(remote.value)
    if (parsed.success) return { settings: parsed.settings, origin: 'remote', warning: null, snapshot: { version: remote.version, savedAt: remote.savedAt, value: remote.value } }
    problem = `réglages de MyBestConsultant (version ${remote.version}) illisibles — ${parsed.error}`
  } else {
    problem = `réglages de MyBestConsultant illisibles (${remote.error})`
  }
  const previous = snapshot ? parseVeilleSettings(snapshot.value) : null
  if (snapshot && previous?.success) {
    return {
      settings: previous.settings,
      origin: 'snapshot',
      warning: `${capitalize(problem)} : ceux de la version ${snapshot.version} du ${frenchDay(snapshot.savedAt)} sont utilisés.`,
      snapshot,
    }
  }
  return { settings: defaults, origin: 'defaults', warning: `${capitalize(problem)} : réglages du dépôt (config/defaults.json) utilisés.`, snapshot }
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
