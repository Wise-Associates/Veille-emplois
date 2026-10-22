// Configuration lue dans les variables d'environnement (voir .env.example), validée au démarrage : une variable
// manquante arrête la veille avant toute lecture plutôt qu'au moment d'envoyer l'e-mail.

import { z } from 'zod'

export const APP_CONFIG = Symbol('APP_CONFIG')

export interface MailConfig {
  host: string
  port: number
  user: string
  password: string
  from: string
  to: string[]
}

export interface AppConfig {
  /** Fichier JSON des annonces déjà vues (voir README, « État de la veille »). */
  stateFile: string
  /** Essai : les sources sont lues et le récapitulatif affiché, mais rien n'est envoyé ni enregistré. */
  dryRun: boolean
  /** Absente en essai uniquement. */
  mail: MailConfig | null
}

const mailSchema = z.object({
  SMTP_HOST: z.string().trim().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().trim().min(1),
  SMTP_PASSWORD: z.string().min(1),
  MAIL_FROM: z.string().trim().min(3),
  MAIL_TO: z
    .string()
    .transform((value) => value.split(',').map((address) => address.trim()).filter(Boolean))
    .pipe(z.array(z.email()).min(1)),
})

const baseSchema = z.object({
  STATE_FILE: z.string().trim().min(1).default('etat/etat.json'),
})

function describeIssues(error: z.ZodError): string {
  // Noms de variables et règle enfreinte seulement : jamais la valeur, qui peut être un mot de passe.
  return error.issues.map((issue) => `${issue.path.join('.') || '(racine)'} : ${issue.message}`).join(' ; ')
}

export function loadConfig(env: Record<string, string | undefined>, dryRun: boolean): AppConfig {
  const base = baseSchema.safeParse(env)
  if (!base.success) throw new Error(`Configuration invalide — ${describeIssues(base.error)}`)
  if (dryRun) return { stateFile: base.data.STATE_FILE, dryRun, mail: null }

  const mail = mailSchema.safeParse(env)
  if (!mail.success) throw new Error(`Configuration de l'envoi des e-mails invalide — ${describeIssues(mail.error)}`)
  return {
    stateFile: base.data.STATE_FILE,
    dryRun,
    mail: {
      host: mail.data.SMTP_HOST,
      port: mail.data.SMTP_PORT,
      user: mail.data.SMTP_USER,
      password: mail.data.SMTP_PASSWORD,
      from: mail.data.MAIL_FROM,
      to: mail.data.MAIL_TO,
    },
  }
}
