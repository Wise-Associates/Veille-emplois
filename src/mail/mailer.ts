import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common'
import nodemailer, { type Transporter } from 'nodemailer'
import { APP_CONFIG, type AppConfig, type MailConfig } from '../config.js'
import type { RenderedEmail } from '../digest/format.js'

/**
 * Erreur SMTP accompagnée de la variable à corriger, quand la cause est reconnue (champs `code` / `command` posés
 * par nodemailer) ; sinon l'erreur telle quelle. La réponse du serveur est gardée : elle ne contient pas le mot de passe.
 */
export function explainSmtpError(error: unknown): unknown {
  const smtp = (error ?? {}) as { code?: unknown; command?: unknown; responseCode?: unknown; message?: unknown }
  const status = typeof smtp.responseCode === 'number' ? smtp.responseCode : 0
  // Code 4xx : refus temporaire (limite d'envoi, serveur occupé), rien à corriger dans la configuration.
  if (status >= 400 && status < 500) {
    return new Error(
      `Refus temporaire du serveur SMTP (limite d'envoi ou serveur occupé) : les offres restantes partiront au passage ` +
        `suivant. Réponse du serveur : ${String(smtp.message)}`,
      { cause: error },
    )
  }
  // Beaucoup de serveurs (IONOS, OVH, Gmail…) n'acceptent comme expéditeur que la boîte connectée ou ses alias.
  if (smtp.command === 'MAIL FROM') {
    return new Error(
      `Adresse d'expédition refusée par le serveur SMTP : l'adresse de MAIL_FROM doit être celle de la boîte SMTP_USER, ` +
        `ou un alias autorisé de cette boîte. Réponse du serveur : ${String(smtp.message)}`,
      { cause: error },
    )
  }
  if (smtp.code === 'EAUTH') {
    return new Error(`Connexion SMTP refusée : vérifiez SMTP_USER et SMTP_PASSWORD. Réponse du serveur : ${String(smtp.message)}`, {
      cause: error,
    })
  }
  return error
}

/**
 * Refus définitif d'un message précis (contenu, taille : code 5xx après DATA), par opposition aux erreurs qui
 * touchent tous les envois (connexion, identifiants, expéditeur, quota ou refus temporaire 4xx) : le premier peut être
 * sauté pour envoyer les suivants, les autres doivent arrêter l'envoi.
 */
export function isMessageRejection(error: unknown): boolean {
  const smtp = (error ?? {}) as { code?: unknown; responseCode?: unknown; cause?: unknown }
  const source = (smtp.code === undefined && smtp.cause ? smtp.cause : smtp) as { code?: unknown; responseCode?: unknown }
  return source.code === 'EMESSAGE' && typeof source.responseCode === 'number' && source.responseCode >= 500
}

/**
 * Envoi des e-mails d'un passage par une seule connexion SMTP, au plus un message par seconde : un premier passage
 * envoie des centaines d'offres, et les serveurs d'envoi bloquent les rafales.
 */
@Injectable()
export class Mailer implements OnModuleDestroy {
  private transport: Transporter | null = null

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Une offre, vers la boîte AO (OFFERS_TO). */
  async sendOffer(email: RenderedEmail): Promise<void> {
    await this.send(email, (mail) => mail.offersTo, 'OFFERS_TO')
  }

  /** Le récapitulatif, vers l'équipe (MAIL_TO). */
  async sendDigest(email: RenderedEmail): Promise<void> {
    await this.send(email, (mail) => mail.digestTo, 'MAIL_TO')
  }

  onModuleDestroy(): void {
    this.transport?.close()
    this.transport = null
  }

  private async send(email: RenderedEmail, recipients: (mail: MailConfig) => string[], variable: string): Promise<void> {
    const mail = this.config.mail
    if (!mail) throw new Error("Envoi demandé sans configuration de messagerie (SMTP_*, MAIL_* et OFFERS_TO dans l'environnement).")
    const to = recipients(mail)
    const info = await this.connection(mail)
      .sendMail({ from: mail.from, to, subject: email.subject, text: email.text, html: email.html })
      .catch((error: unknown) => {
        throw explainSmtpError(error)
      })
    // nodemailer ne rejette que si tous les destinataires sont refusés. Un refus partiel doit aussi arrêter : sinon
    // l'offre serait retenue comme envoyée alors qu'une boîte ne l'a pas reçue. (Nombre seulement : les adresses ne
    // vont pas dans les journaux.)
    const rejected = info.rejected ?? []
    if (rejected.length > 0) {
      throw new Error(`Message refusé par le serveur SMTP pour ${rejected.length} destinataire(s) sur ${to.length} : vérifiez ${variable}.`)
    }
  }

  private connection(mail: MailConfig): Transporter {
    this.transport ??= nodemailer.createTransport({
      host: mail.host,
      port: mail.port,
      // 465 : TLS dès la connexion ; sinon STARTTLS, exigé pour ne jamais envoyer le mot de passe en clair.
      secure: mail.port === 465,
      requireTLS: mail.port !== 465,
      auth: { user: mail.user, pass: mail.password },
      pool: true,
      maxConnections: 1,
      // Nouvelle connexion tous les 10 messages : IONOS refuse au-delà de 20 messages par connexion (« 451 Mails per
      // session limit exceeded », constaté le 23/10/2026), d'autres serveurs ont des limites voisines.
      maxMessages: 10,
      rateDelta: 1_000,
      rateLimit: 1,
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 60_000,
    })
    return this.transport
  }
}
