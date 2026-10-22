import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { explainSmtpError } from './mailer.js'

// Erreurs construites comme celles de nodemailer (code, command, responseCode), réponses de serveur fictives.
const smtpError = (fields: Record<string, unknown>, message: string) => Object.assign(new Error(message), fields)

describe('erreurs d\'envoi SMTP', () => {
  it('nomme la variable à corriger quand le serveur refuse l\'expéditeur', () => {
    const refused = smtpError({ code: 'EENVELOPE', command: 'MAIL FROM', responseCode: 550 }, 'Mail command failed: 550 Sender address is not allowed.')
    const explained = explainSmtpError(refused) as Error
    assert.match(explained.message, /MAIL_FROM doit être celle de la boîte SMTP_USER/)
    assert.match(explained.message, /550 Sender address is not allowed/)
    assert.equal(explained.cause, refused)
  })

  it('nomme les variables d\'identification quand la connexion est refusée', () => {
    const explained = explainSmtpError(smtpError({ code: 'EAUTH', command: 'AUTH PLAIN' }, 'Invalid login: 535 Authentication credentials invalid')) as Error
    assert.match(explained.message, /SMTP_USER et SMTP_PASSWORD/)
  })

  it('laisse les autres erreurs telles quelles', () => {
    const timeout = smtpError({ code: 'ETIMEDOUT' }, 'Connection timeout')
    assert.equal(explainSmtpError(timeout), timeout)
  })
})
