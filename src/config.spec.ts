import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.js'

const mailEnv = {
  SMTP_HOST: 'smtp.exemple.test',
  SMTP_USER: 'veille@exemple.test',
  SMTP_PASSWORD: 'mot-de-passe-fictif',
  MAIL_FROM: 'Veille <veille@exemple.test>',
  OFFERS_TO: 'ao@exemple.test',
  MAIL_TO: 'equipe@exemple.test, direction@exemple.test',
}

describe('configuration', () => {
  it('n\'exige pas la messagerie pour un essai', () => {
    assert.deepEqual(loadConfig({}, true), { stateFile: 'etat/etat.json', dryRun: true, maxOfferEmailsPerRun: 200, digestMode: 'always', mail: null })
  })

  it('lit la messagerie, la boîte AO et les destinataires du récapitulatif', () => {
    const config = loadConfig({ ...mailEnv, STATE_FILE: 'etat/veille.json', MAX_OFFER_EMAILS_PER_RUN: '50' }, false)
    assert.equal(config.stateFile, 'etat/veille.json')
    assert.equal(config.maxOfferEmailsPerRun, 50)
    assert.equal(config.mail?.port, 587)
    assert.deepEqual(config.mail?.offersTo, ['ao@exemple.test'])
    assert.deepEqual(config.mail?.digestTo, ['equipe@exemple.test', 'direction@exemple.test'])
  })

  it('refuse une configuration incomplète sans jamais afficher le mot de passe', () => {
    assert.throws(
      () => loadConfig({ ...mailEnv, SMTP_HOST: '', MAIL_TO: 'pas-une-adresse', OFFERS_TO: undefined }, false),
      (error: Error) =>
        /SMTP_HOST/.test(error.message) &&
        /MAIL_TO/.test(error.message) &&
        /OFFERS_TO/.test(error.message) &&
        !error.message.includes('mot-de-passe-fictif'),
    )
  })

  it('prend les valeurs par défaut pour les variables vides (non définies dans GitHub)', () => {
    const config = loadConfig({ ...mailEnv, SMTP_PORT: '', MAX_OFFER_EMAILS_PER_RUN: '' }, false)
    assert.equal(config.mail?.port, 587)
    assert.equal(config.maxOfferEmailsPerRun, 200)
  })

  it('lit le mode du récapitulatif, « always » par défaut', () => {
    assert.equal(loadConfig({ DIGEST_MODE: 'problems' }, true).digestMode, 'problems')
    assert.equal(loadConfig({ DIGEST_MODE: '' }, true).digestMode, 'always')
    assert.throws(() => loadConfig({ DIGEST_MODE: 'jamais' }, true), /DIGEST_MODE/)
  })

  it('refuse un plafond d\'envoi aberrant', () => {
    assert.throws(() => loadConfig({ MAX_OFFER_EMAILS_PER_RUN: '0' }, true), /MAX_OFFER_EMAILS_PER_RUN/)
  })
})
