import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderRunAlert } from './alert-email.js'

describe('alerte d\'échec d\'un passage', () => {
  it('donne la date du passage à l\'heure de Paris, chaque problème, l\'état et la marche à suivre', () => {
    const email = renderRunAlert({
      startedAt: new Date('2026-11-05T05:00:00Z'),
      problems: ['Passage interrompu, état non enregistré : Fichier d\'état invalide (version fictive)'],
      stateSaved: false,
    })
    assert.equal(email.subject, 'Veille marchés et emplois — échec du passage du 05/11/2026 à 06:00')
    assert.match(email.text, /^- Passage interrompu, état non enregistré : Fichier d'état invalide \(version fictive\)$/m)
    assert.match(email.text, /État non enregistré : les offres envoyées pendant ce passage repartiront au suivant/)
    assert.match(email.text, /docker logs --since 12h veille/)
    assert.equal(email.attachments, undefined)
  })

  it('dit que l\'état est enregistré quand seuls des envois ont échoué, et échappe les messages', () => {
    const email = renderRunAlert({ startedAt: new Date('2026-07-01T13:00:00Z'), problems: ['Réponse <b>fictive</b>'], stateSaved: true })
    assert.match(email.subject, /01\/07\/2026 à 15:00$/, 'heure d\'été')
    assert.match(email.text, /État enregistré : les offres déjà envoyées ne repartiront pas/)
    assert.ok(email.html.includes('Réponse &lt;b&gt;fictive&lt;/b&gt;'))
    assert.ok(!email.html.includes('<b>fictive'))
  })
})
