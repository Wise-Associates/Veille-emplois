import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { explainSmtpError, isMessageRejection } from './mailer.js'

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

  it('ne met pas en cause la configuration pour un refus temporaire (limite d\'envoi)', () => {
    const limit = smtpError(
      { code: 'EENVELOPE', command: 'MAIL FROM', responseCode: 451 },
      'Mail command failed: 451-Requested action aborted 451-Mails per session limit exceeded.',
    )
    const explained = explainSmtpError(limit) as Error
    assert.match(explained.message, /^Refus temporaire du serveur SMTP/)
    assert.match(explained.message, /Mails per session limit exceeded/)
    assert.doesNotMatch(explained.message, /MAIL_FROM/)
  })

  it('nomme les variables d\'identification quand la connexion est refusée', () => {
    const explained = explainSmtpError(smtpError({ code: 'EAUTH', command: 'AUTH PLAIN' }, 'Invalid login: 535 Authentication credentials invalid')) as Error
    assert.match(explained.message, /SMTP_USER et SMTP_PASSWORD/)
  })

  it('distingue le refus d\'un message précis des erreurs qui arrêtent tout envoi', () => {
    assert.equal(isMessageRejection(smtpError({ code: 'EMESSAGE', command: 'DATA', responseCode: 554 }, 'Message failed: 554 rejected as spam')), true)
    assert.equal(isMessageRejection(smtpError({ code: 'EMESSAGE', command: 'DATA', responseCode: 451 }, 'Message failed: 451 try again later')), false, 'temporaire')
    assert.equal(isMessageRejection(smtpError({ code: 'EENVELOPE', command: 'MAIL FROM', responseCode: 550 }, 'Mail command failed')), false)
    assert.equal(isMessageRejection(new Error('Connection timeout')), false)
  })

  it('laisse les autres erreurs telles quelles', () => {
    const timeout = smtpError({ code: 'ETIMEDOUT' }, 'Connection timeout')
    assert.equal(explainSmtpError(timeout), timeout)
  })
})
