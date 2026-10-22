import { Inject, Injectable } from '@nestjs/common'
import nodemailer from 'nodemailer'
import { APP_CONFIG, type AppConfig } from '../config.js'
import type { Digest } from '../digest/digest.js'

/**
 * Erreur SMTP accompagnée de la variable à corriger, quand la cause est reconnue (champs `code` / `command` posés
 * par nodemailer) ; sinon l'erreur telle quelle. La réponse du serveur est gardée : elle ne contient pas le mot de passe.
 */
export function explainSmtpError(error: unknown): unknown {
  const smtp = (error ?? {}) as { code?: unknown; command?: unknown; message?: unknown }
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

@Injectable()
export class Mailer {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async send(digest: Digest): Promise<void> {
    const mail = this.config.mail
    if (!mail) throw new Error("Envoi demandé sans configuration de messagerie (SMTP_* et MAIL_* dans l'environnement).")
    const transport = nodemailer.createTransport({
      host: mail.host,
      port: mail.port,
      // 465 : TLS dès la connexion ; sinon STARTTLS, exigé pour ne jamais envoyer le mot de passe en clair.
      secure: mail.port === 465,
      requireTLS: mail.port !== 465,
      auth: { user: mail.user, pass: mail.password },
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 60_000,
    })
    try {
      const info = await transport
        .sendMail({ from: mail.from, to: mail.to, subject: digest.subject, text: digest.text, html: digest.html })
        .catch((error: unknown) => {
          throw explainSmtpError(error)
        })
      // nodemailer ne rejette que si tous les destinataires sont refusés. Un refus partiel doit aussi arrêter le
      // passage : sinon l'état serait enregistré alors qu'une partie de l'équipe n'a rien reçu. (Nombre seulement :
      // les adresses ne vont pas dans les journaux.)
      if (info.rejected.length > 0) {
        throw new Error(`Récapitulatif refusé par le serveur SMTP pour ${info.rejected.length} destinataire(s) sur ${mail.to.length} : vérifiez MAIL_TO.`)
      }
    } finally {
      transport.close()
    }
  }
}
