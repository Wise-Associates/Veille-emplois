import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { htmlToText, limitText, MAX_DESCRIPTION_CHARS } from './text.js'

describe('texte des descriptions', () => {
  it('garde paragraphes et listes, décode les entités et retire les espaces superflus', () => {
    const html = '<p>Missions&nbsp;:</p><ul><li>Piloter le projet <b>fictif</b></li><li>Animer l&#8217;équipe</li></ul><p>Profil   :<br>Bac+5</p>'
    assert.equal(htmlToText(html), "Missions :\n- Piloter le projet fictif\n- Animer l’équipe\n\nProfil :\nBac+5")
  })

  it('ignore les scripts et styles', () => {
    assert.equal(htmlToText('<style>p{}</style><p>Texte</p><script>alert(1)</script>'), 'Texte')
  })

  it('coupe une description trop longue', () => {
    const text = limitText('a'.repeat(MAX_DESCRIPTION_CHARS + 50))
    assert.equal(text.length, MAX_DESCRIPTION_CHARS + 1)
    assert.ok(text.endsWith('…'))
  })
})
