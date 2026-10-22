import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.js'

const mailEnv = {
  SMTP_HOST: 'smtp.exemple.test',
  SMTP_USER: 'veille@exemple.test',
  SMTP_PASSWORD: 'mot-de-passe-fictif',
  MAIL_FROM: 'Veille <veille@exemple.test>',
  MAIL_TO: 'equipe@exemple.test, direction@exemple.test',
}

describe('configuration', () => {
  it('n\'exige pas la messagerie pour un essai', () => {
    assert.deepEqual(loadConfig({}, true), { stateFile: 'etat/etat.json', dryRun: true, mail: null })
  })

  it('lit la messagerie et la liste des destinataires', () => {
    const config = loadConfig({ ...mailEnv, STATE_FILE: 'etat/veille.json' }, false)
    assert.equal(config.stateFile, 'etat/veille.json')
    assert.equal(config.mail?.port, 587)
    assert.deepEqual(config.mail?.to, ['equipe@exemple.test', 'direction@exemple.test'])
  })

  it('refuse une configuration incomplète sans jamais afficher le mot de passe', () => {
    assert.throws(
      () => loadConfig({ ...mailEnv, SMTP_HOST: '', MAIL_TO: 'pas-une-adresse' }, false),
      (error: Error) => /SMTP_HOST/.test(error.message) && /MAIL_TO/.test(error.message) && !error.message.includes('mot-de-passe-fictif'),
    )
  })
})
