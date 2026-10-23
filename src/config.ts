// Configuration lue dans les variables d'environnement (voir .env.example), validée au démarrage : une variable
// manquante arrête la veille avant toute lecture plutôt qu'au moment d'envoyer les e-mails.

import { z } from 'zod'

export const APP_CONFIG = Symbol('APP_CONFIG')

export interface MailConfig {
  host: string
  port: number
  user: string
  password: string
  from: string
  /** Boîte AO de MyBestConsultant : un e-mail par offre. */
  offersTo: string[]
  /** Équipe : le récapitulatif quotidien. */
  digestTo: string[]
}

export interface AppConfig {
  /** Fichier JSON des annonces déjà vues (voir README, « État de la veille »). */
  stateFile: string
  /** Essai : les sources sont lues et les e-mails affichés, mais rien n'est envoyé ni enregistré. */
  dryRun: boolean
  /**
   * Offres envoyées au plus par passage : borne la durée du passage et le volume confié en une fois au serveur
   * d'envoi (la plupart limitent le nombre de messages par heure). Le reste part aux passages suivants.
   */
  maxOfferEmailsPerRun: number
  /**
   * `always` : le récapitulatif part à chaque passage. `problems` : seulement s'il y a un point à vérifier ; pour les
   * passages de la journée, après celui du matin qui l'envoie toujours (voir le workflow).
   */
  digestMode: DigestMode
  /** Absente en essai uniquement. */
  mail: MailConfig | null
}

export type DigestMode = 'always' | 'problems'

/** Nombre facultatif : une variable vide (secret ou variable GitHub non définis) prend la valeur par défaut. */
const optionalInt = (fallback: number, min: number, max: number) =>
  z.preprocess((value) => (value === '' ? undefined : value), z.coerce.number().int().min(min).max(max).default(fallback))

const addressList = z
  .string()
  .transform((value) => value.split(',').map((address) => address.trim()).filter(Boolean))
  .pipe(z.array(z.email()).min(1))

const mailSchema = z.object({
  SMTP_HOST: z.string().trim().min(1),
  SMTP_PORT: optionalInt(587, 1, 65535),
  SMTP_USER: z.string().trim().min(1),
  SMTP_PASSWORD: z.string().min(1),
  MAIL_FROM: z.string().trim().min(3),
  OFFERS_TO: addressList,
  MAIL_TO: addressList,
})

const baseSchema = z.object({
  STATE_FILE: z.string().trim().min(1).default('etat/etat.json'),
  MAX_OFFER_EMAILS_PER_RUN: optionalInt(200, 1, 2000),
  DIGEST_MODE: z.preprocess((value) => (value === '' ? undefined : value), z.enum(['always', 'problems']).default('always')),
})

function describeIssues(error: z.ZodError): string {
  // Noms de variables et règle enfreinte seulement : jamais la valeur, qui peut être un mot de passe.
  return error.issues.map((issue) => `${issue.path.join('.') || '(racine)'} : ${issue.message}`).join(' ; ')
}

export function loadConfig(env: Record<string, string | undefined>, dryRun: boolean): AppConfig {
  const base = baseSchema.safeParse(env)
  if (!base.success) throw new Error(`Configuration invalide — ${describeIssues(base.error)}`)
  const common = {
    stateFile: base.data.STATE_FILE,
    dryRun,
    maxOfferEmailsPerRun: base.data.MAX_OFFER_EMAILS_PER_RUN,
    digestMode: base.data.DIGEST_MODE,
  }
  if (dryRun) return { ...common, mail: null }

  const mail = mailSchema.safeParse(env)
  if (!mail.success) throw new Error(`Configuration de l'envoi des e-mails invalide — ${describeIssues(mail.error)}`)
  return {
    ...common,
    mail: {
      host: mail.data.SMTP_HOST,
      port: mail.data.SMTP_PORT,
      user: mail.data.SMTP_USER,
      password: mail.data.SMTP_PASSWORD,
      from: mail.data.MAIL_FROM,
      offersTo: mail.data.OFFERS_TO,
      digestTo: mail.data.MAIL_TO,
    },
  }
}
