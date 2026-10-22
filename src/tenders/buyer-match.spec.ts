import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { containsPhrase, matchOrganisation, normalize } from './buyer-match.js'

const byName = (name: string, text = '') => matchOrganisation({ buyers: [{ name }], text })

describe('reconnaissance de l\'acheteur d\'un avis', () => {
  it('compare les noms sans accents, majuscules ni ponctuation, mot à mot', () => {
    assert.equal(normalize("Agence des Participations de l'État"), 'agence des participations de l etat')
    assert.equal(containsPhrase(normalize('069-DRFIP'), 'drfip'), true)
    assert.equal(containsPhrase(normalize('INSEED Paris'), 'insee'), false, 'mot entier seulement')
    assert.equal(containsPhrase(normalize('PROPARCO_75'), 'proparco*'), true, '* accepte la suite du mot')
    assert.equal(containsPhrase(normalize('Aspres'), 'a s p'), false)
  })

  it('reconnaît un acheteur par le SIREN de son SIRET, quel que soit le nom saisi', () => {
    assert.equal(matchOrganisation({ buyers: [{ name: 'Direction des achats', siret: '18003501600054' }], text: '' }), 'acoss')
    assert.equal(matchOrganisation({ buyers: [{ name: 'DDSI', siret: '180035024' }], text: '' }), 'cnam', 'SIREN seul')
  })

  it('reconnaît un acheteur par les variantes de son nom', () => {
    assert.equal(byName('Caisse nationale assurance maladie DDSI'), 'cnam')
    assert.equal(byName("CAISSE NATIONALE DE L'ASSURANCE MALADIE"), 'cnam')
    assert.equal(byName('A.S.P.'), 'asp')
    assert.equal(byName('ACOSS (Urssaf Caisse Nationale)'), 'acoss')
    assert.equal(byName("AGENCE DES PARTICIPATIONS DE L'ETAT"), 'ape')
    assert.equal(byName('DRFIP 44'), 'dgfip-reseau')
    assert.equal(byName('Direction départementale des Finances publiques des Yvelines'), 'dgfip-reseau')
    assert.equal(byName('ETAT-DGFIP'), 'dgfip')
    assert.equal(byName('PROPARCO_75'), 'proparco')
  })

  it('écarte les homonymes', () => {
    assert.equal(byName('CNAM - Conservatoire national des arts et métiers'), null)
    assert.equal(byName('URSSAF de Bretagne'), null, 'une Urssaf régionale n\'est pas la caisse nationale')
    assert.equal(byName("DRFIP BFC pour l'ARFIP Association"), null)
    assert.equal(byName('DGFIP - ARFIP Association fictive'), null)
    assert.equal(byName('C.C. des Aspres'), null)
    assert.equal(byName('INSERM'), null)
    assert.equal(byName('Cour des comptes européenne'), null)
  })

  it('ne se fie jamais au SIRET partagé des services de l\'État, seulement au nom', () => {
    assert.equal(matchOrganisation({ buyers: [{ name: "SERVICES DE L'ETAT", siret: '11000201100044' }], text: '' }), null)
    assert.equal(matchOrganisation({ buyers: [{ name: 'Cour des comptes', siret: '11000201100044' }], text: '' }), 'cour-des-comptes')
  })

  it('ne retient un achat des Services du Premier ministre que s\'il concerne la DINUM', () => {
    assert.equal(byName('SPM - DSAF', 'Accompagnement des produits numériques de la DINUM'), 'dinum')
    assert.equal(byName('Services du Premier ministre', 'Prestations pour la Direction interministérielle du numérique'), 'dinum')
    assert.equal(byName('SPM - DSAF', 'Nettoyage des locaux de la DILA'), null)
  })

  it('rattache un avis reconnu par deux organismes au premier de la liste', () => {
    assert.equal(byName('DGFIP - DRFIP 44'), 'dgfip')
  })

  it('reconnaît un achat groupé dès qu\'un des acheteurs est suivi', () => {
    const notice = { buyers: [{ name: 'CNAV', siret: '18003501700011' }, { name: 'Caisse nationale de l\'Assurance Maladie' }], text: '' }
    assert.equal(matchOrganisation(notice), 'cnam')
  })
})
