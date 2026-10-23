import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { beetweenJobToListing } from './autorite-concurrence.source.js'
import { parseBanquePostaleOfferPage, parseBanquePostalePage } from './banque-postale.source.js'
import { parseCspFeed, parseCspOfferPage } from './choisir-le-service-public.source.js'
import { findRecruitmentLinks } from './crh.source.js'
import { extractCareerSiteContext, isProparcoLocation, isProparcoTitle } from './proparco.source.js'
import { parseCareersFeed, parseJobPostingPage } from './rss-careers.source.js'

// Contenus fictifs, construits sur la structure réelle des sites (octobre 2026).

const rss = (items: string) => `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Offres</title>${items}</channel></rss>`

describe('offres de Choisir le service public', () => {
  it('prend la référence en tête du titre comme identifiant et construit le lien de l\'offre', () => {
    const xml = rss(`<item>
      <link>https://choisirleservicepublic.gouv.fr/offre-emploi/2026-0000001/?tracking=1&amp;idOrigine=502</link>
      <category>Numérique/Cheffe de projet</category>
      <category>Emploi ouvert aux contractuels</category>
      <category>1 rue Fictive 75000 Paris</category>
      <title>2026-0000001 - Cheffe de projet fictive H/F</title>
      <pubDate>Thu, 22 Oct 2026 00:40:15 Z</pubDate>
    </item>`)
    assert.deepEqual(parseCspFeed(xml, 'dinum'), [
      {
        kind: 'job',
        id: '2026-0000001',
        organisationId: 'dinum',
        title: 'Cheffe de projet fictive H/F',
        url: 'https://choisirleservicepublic.gouv.fr/offre-emploi/2026-0000001/',
        location: '1 rue Fictive 75000 Paris',
        details: ['Numérique/Cheffe de projet', 'Emploi ouvert aux contractuels'],
        description: undefined,
      },
    ])
  })

  it('reprend la description du flux en texte brut', () => {
    const xml = rss(`<item><title>2026-0000002 - Offre fictive</title><link>https://choisirleservicepublic.gouv.fr/offre-emploi/2026-0000002/</link>
      <description>&lt;b&gt;Description du poste : &lt;/b&gt;&lt;br /&gt;Piloter un projet fictif</description></item>`)
    assert.equal(parseCspFeed(xml, 'dinum')[0]?.description, 'Description du poste :\nPiloter un projet fictif')
  })

  it('lit sur la page de l\'offre l\'employeur, la date de publication et la date limite', () => {
    const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"Offre fictive","datePosted":"19/10/2026",
      "hiringOrganization":"Direction fictive (DINUM)"}</script><main><p>Date limite de candidature : 16/11/2026</p></main>`
    const listing = parseCspFeed(rss('<item><title>2026-0000003 - Offre fictive</title><link>x</link><category>Numérique</category></item>'), 'dinum')[0]
    assert.ok(listing)
    assert.deepEqual(parseCspOfferPage(html, listing), {
      publishedOn: '2026-10-19',
      deadline: '2026-11-16',
      details: ['Employeur : Direction fictive (DINUM)', 'Numérique'],
    })
    assert.throws(() => parseCspOfferPage('<html><body>Offre dépubliée</body></html>', listing), /Page sans offre/)
  })

  it('refuse une offre sans référence plutôt que de la suivre sans identifiant stable', () => {
    assert.throws(() => parseCspFeed(rss('<item><title>Sans référence</title><link>https://exemple.test/</link></item>'), 'dinum'), /sans référence/)
  })

  it('refuse un document qui n\'est pas un flux RSS (page d\'erreur, maintenance)', () => {
    assert.throws(() => parseCspFeed('<html><body>Maintenance</body></html>', 'dinum'), /pas un flux RSS/)
  })
})

describe('flux carrières (SFIL, Expertise France)', () => {
  it('sépare le département du titre des offres d\'Expertise France', () => {
    const xml = rss(`<item>
      <title>Département Gouvernance - GOUV - Responsable fictif (F/H)</title>
      <pubDate>Thu, 22 Oct 2026 14:05:32 +0200</pubDate>
      <link>https://expertise-france.gestmax.fr/10001/1/responsable-fictif</link>
      <guid isPermaLink="false">10001</guid>
    </item>`)
    const [listing] = parseCareersFeed(xml, 'expertise-france', 'expertise-france.gestmax.fr')
    assert.equal(listing?.id, '10001')
    assert.equal(listing?.title, 'Responsable fictif (F/H)')
    assert.deepEqual(listing?.details, ['Département Gouvernance - GOUV'])
    assert.equal(listing?.publishedOn, '2026-10-22')
  })

  it('décode les entités des titres WordPress', () => {
    const xml = rss(`<item><title>Stage &#8211; Juriste fictif</title><link>https://sfil.fr/offres-emploi/juriste-fictif/</link>
      <guid isPermaLink="false">https://sfil.fr/offres-emploi/juriste-fictif/</guid></item>`)
    assert.equal(parseCareersFeed(xml, 'sfil', 'sfil.fr')[0]?.title, 'Stage – Juriste fictif')
  })

  it('prend le texte complet d\'une offre WordPress (content:encoded)', () => {
    const xml = rss(`<item><title>CDI – Ingénieur fictif</title><link>https://sfil.fr/offres-emploi/ingenieur-fictif/</link>
      <description><![CDATA[<p>Résumé coupé…</p>]]></description>
      <content:encoded><![CDATA[<p><strong>Missions</strong></p><ul><li>Concevoir des outils fictifs</li></ul>]]></content:encoded></item>`)
    assert.equal(parseCareersFeed(xml, 'sfil', 'sfil.fr')[0]?.description, 'Missions\n- Concevoir des outils fictifs')
  })

  it('lit la description, la date limite et le lieu dans les données structurées d\'une page d\'offre', () => {
    const html = `<script type="application/ld+json">{"@type":"JobPosting","description":"<p>Mission d&#8217;expertise fictive</p>",
      "datePosted":"2026-10-22T00:00:00","validThrough":"2026-11-07T00:00:00",
      "jobLocation":{"@type":"Place","address":{"addressLocality":"","addressRegion":"Afrique","addressCountry":"Cap Vert"}}}</script>`
    assert.deepEqual(parseJobPostingPage(html), {
      description: 'Mission d’expertise fictive',
      deadline: '2026-11-07',
      publishedOn: '2026-10-22',
      location: 'Cap Vert',
    })
  })

  it('refuse un lien d\'offre vers un autre site que celui de l\'organisme', () => {
    const xml = rss('<item><title>Offre fictive</title><link>https://sfil-recrutement.exemple.test/connexion</link><guid>1</guid></item>')
    assert.throws(() => parseCareersFeed(xml, 'sfil', 'sfil.fr'), /Lien d'offre inattendu/)
  })
})

describe('sites carrières', () => {
  it('Autorité de la concurrence : reprend les champs utiles de l\'API', () => {
    const listing = beetweenJobToListing({
      id: '100001',
      title: ' Stage fictif ',
      url: 'https://autoritedelaconcurrence.nos-recrutements.fr/job/fictif',
      creationDate: '2026-10-12T00:00:00.000+00:00',
      city: 'Paris',
      contractType: 'Stage',
      descriptionMission: '<p>Analyser des données fictives</p>',
      descriptionProfile: '<p>Master en économie</p>',
    })
    assert.deepEqual(listing, {
      kind: 'job',
      id: '100001',
      organisationId: 'autorite-concurrence',
      title: 'Stage fictif',
      url: 'https://autoritedelaconcurrence.nos-recrutements.fr/job/fictif',
      publishedOn: '2026-10-12',
      location: 'Paris',
      details: ['Stage'],
      description: 'Missions\nAnalyser des données fictives\n\nProfil recherché\nMaster en économie',
    })
  })

  it('La Banque Postale : lit le texte de l\'offre sur sa page, sans la présentation générale', () => {
    const section = (title: string, body: string) =>
      `<div class="o-jobOffer-details__content"><h2 class="o-jobOffer-details__content__title">${title}</h2>` +
      `<div class="o-jobOffer-details__content__desc m-text"><p>${body}</p></div></div>`
    const html = section('Introduction', 'Présentation générale') + section("Description de l'offre", 'Analyser des dossiers fictifs') +
      section('Informations complémentaires', 'Bac+5 fictif')
    assert.deepEqual(parseBanquePostaleOfferPage(html), {
      description: "Description de l'offre\nAnalyser des dossiers fictifs\n\nInformations complémentaires\nBac+5 fictif",
    })
    assert.throws(() => parseBanquePostaleOfferPage('<html><body>Access Denied</body></html>'), /Texte de l'offre introuvable/)
  })

  it('La Banque Postale : lit les cartes d\'offres et le nombre de pages', () => {
    const html = `<div class="o-jobOfferList"><p>87 offres correspondent</p>
      <div class="o-jobOffer__push js-has-link">
        <p class="o-jobOffer__push__tags"><span class="a-cat-tag a-cat-tag--warning"> Nouveau ! </span>
          <span class="a-cat-tag a-cat-tag--compte"><span class="sr-only">Type de contrat :</span> <span>CDI</span></span></p>
        <h3 class="a-body--large-bold">Analyste fictif F/H</h3>
        <p class="o-jobOffer__push__infos"><span><svg></svg> Paris </span><span><svg></svg> LA BANQUE POSTALE </span></p>
        <time datetime="2026-10-20">20 octobre 2026</time>
        <a href="/candidats/offres-d-emploi/nos-offres-d-emploi.job-1234.html/analyste-fictif.html">Voir l'offre</a>
      </div><nav>Page 1 sur 22</nav></div>`
    const page = parseBanquePostalePage(html)
    assert.equal(page.pageCount, 22)
    assert.deepEqual(page.listings, [
      {
        kind: 'job',
        id: '1234',
        organisationId: 'banque-postale',
        title: 'Analyste fictif F/H',
        url: 'https://www.labanquepostale.com/candidats/offres-d-emploi/nos-offres-d-emploi.job-1234.html/analyste-fictif.html',
        publishedOn: '2026-10-20',
        location: 'Paris',
        details: ['CDI', 'LA BANQUE POSTALE'],
      },
    ])
  })

  it('La Banque Postale : signale une page dont la structure a changé', () => {
    assert.throws(() => parseBanquePostalePage('<html><body>Bienvenue</body></html>'), /Nombre de pages introuvable/)
  })

  it('CRH : trouve le lien de recrutement et encode ses accents en UTF-8', () => {
    const html =
      '<title>CRH - Caisse de Refinancement de l\'Habitat</title><ul><li><a href="Info/rapport.pdf">Rapport annuel</a></li>' +
      '<li><a href="Info/annonce_Collatéral.pdf">La CRH recrute</a></li></ul>'
    assert.deepEqual(findRecruitmentLinks(html), [{ text: 'La CRH recrute', url: 'https://www.crh-bonds.com/Info/annonce_Collat%C3%A9ral.pdf' }])
  })

  it('CRH : ne prend pas une page de maintenance pour « aucun recrutement »', () => {
    assert.throws(() => findRecruitmentLinks('<html><title>Maintenance</title><body>Site en maintenance</body></html>'), /pas été reconnue/)
    assert.deepEqual(findRecruitmentLinks('<title>CRH</title><a href="Info/rapport.pdf">Rapport</a>'), [], 'accueil sans poste ouvert')
  })

  it('CRH : refuse un lien de recrutement vers un autre site', () => {
    assert.throws(() => findRecruitmentLinks('<title>CRH</title><a href="https://exemple.test/x.pdf">La CRH recrute</a>'), /hors du site/)
  })

  it('La Banque Postale : ne devine pas le nombre de pages dans un texte quelconque', () => {
    assert.throws(() => parseBanquePostalePage('<div class="o-jobOffer__push"><h3>CDD sur 12 mois</h3></div><p>1 / 22</p>'), /Nombre de pages introuvable/)
  })

  it('Autorité de la concurrence : refuse un lien d\'offre vers un autre site', () => {
    assert.throws(() => beetweenJobToListing({ id: '1', title: 'Stage fictif', url: 'https://exemple.test/job/1' }), /Lien d'offre inattendu/)
  })

  it('Proparco : lit le jeton de la page et ne l\'envoie qu\'à l\'API Cornerstone', () => {
    const page = (cloud: string) =>
      `<script>csod.context={"corp":"afd","endpoints":{"cloud":"${cloud}","api":"/"},"token":"jeton-fictif-0123456789abcdef"};</script>`
    assert.deepEqual(extractCareerSiteContext(page('https://uk.api.csod.com/')), {
      token: 'jeton-fictif-0123456789abcdef',
      apiBase: 'https://uk.api.csod.com/',
    })
    assert.throws(() => extractCareerSiteContext(page('https://exemple.test/')), /Adresse d'API inattendue/)
    assert.throws(() => extractCareerSiteContext('<html></html>'), /introuvable/)
  })

  it('Proparco : reconnaît ses offres par le titre ou par le lieu principal', () => {
    assert.equal(isProparcoTitle("CDD - CHARGÉ D'AFFAIRES FICTIF - PROPARCO - F/H"), true)
    assert.equal(isProparcoTitle('CDD JURISTE FICTIF (H/F)'), false)
    assert.equal(isProparcoLocation('PROPARCO SIEGE'), true)
    assert.equal(isProparcoLocation('AFD DOUALA'), false)
  })
})
