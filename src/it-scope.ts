// Périmètre de la veille : seuls les projets informatiques sont envoyés à la boîte AO (décision du 23/10/2026).
// Règles pures, testées dans it-scope.spec.ts, à vérifier sur les offres réelles avant de les élargir ou les resserrer.
//
// Appels d'offres : services informatiques et logiciels, d'après la classification européenne (CPV 72 : services
// informatiques — conseil, développement, intégration, support, hébergement ; CPV 48 : logiciels et systèmes
// d'information) ou les descripteurs du BOAMP. Hors périmètre : matériel, maintenance de serveurs et réseaux,
// télécommunications, travaux. Un avis sans aucune classification est jugé sur son intitulé.
//
// Offres d'emploi : métiers techniques, données / IA / cybersécurité, projets informatiques et SI métier (AMOA,
// business analyst, ERP, SI financiers), métiers du numérique (UX/UI, web), d'après l'intitulé et la catégorie.

import type { Listing, SourceBatch } from './listing.js'
import { containsPhrase, normalize } from './tenders/buyer-match.js'

/** Préfixes CPV des services informatiques (72) et des logiciels et systèmes d'information (48). */
const IT_CPV_PREFIXES = ['72', '48']

/** Descripteurs du BOAMP (thésaurus de la DILA) des services informatiques et logiciels, normalisés. */
const IT_BOAMP_DESCRIPTORS = new Set(['informatique prestations de services', 'logiciel'])

/**
 * Expressions informatiques, comparées mot à mot sans accents ni majuscules (`*` final : début de mot). Jamais de
 * mot seul ambigu : « réseau » (réseau d'agences), « architecte » (bâtiment), « infrastructure » (travaux),
 * « application » (d'une règle), « hébergement » (logement), « urbaniste » (urbanisme) n'y sont qu'en expression.
 */
const IT_PHRASES = [
  // Informatique et numérique en général
  'informatique', 'informatiques', 'informaticien*', 'numerique', 'numeriques', 'digital*', 'digitaux',
  'dematerialisation', 'logiciel', 'logiciels', 'progiciel*', 'systeme d information', 'systemes d information',
  'systeme d informations', 'systemes d informations', 'saas', 'cloud',
  // Métiers techniques
  'developpeur*', 'developpeuse*', 'developpement informatique', 'developpement logiciel', 'developpement web',
  'developpement d applications', 'full stack', 'fullstack', 'back end', 'backend', 'front end', 'frontend', 'devops',
  'devsecops', 'kubernetes', 'java', 'python', 'javascript', 'typescript', 'php', 'react', 'angular',
  'architecte logiciel', 'architecte technique', 'architecte solution*', 'architecte cloud', 'architecte data',
  'architecte d entreprise', 'architecte applicatif', 'architecte reseau*', 'architecte securite',
  'architecte des systemes', 'tech lead', 'techlead', 'lead dev', 'ingenieur logiciel', 'ingenieur developpement',
  'ingenieur systeme*', 'ingenieur reseau*', 'ingenieur cloud', 'ingenieur securite', 'administrateur systeme*',
  'administrateur reseau*', 'administrateur d outils', 'administratrice systeme*', 'technicien informatique',
  'technicien reseau*', 'technicienne informatique', 'technicien support', 'support informatique', 'support utilisateur*',
  'helpdesk', 'help desk', 'service desk', 'poste de travail', 'postes de travail', 'exploitation informatique',
  'production informatique', 'infrastructure informatique', 'infrastructures informatiques', 'systemes et reseaux',
  'reseaux et telecom*', 'testeur', 'testeuse', 'test logiciel', 'tests logiciels', 'recette applicative',
  'integrateur', 'integratrice', 'applicatif', 'applicative', 'applicatifs', 'applicatives', 'responsable d applications',
  'gestionnaire d applications', 'api',
  // Données, IA, cybersécurité
  'data', 'big data', 'datascience', 'science des donnees', 'sciences des donnees', 'ingenieur de donnees',
  'ingenieur des donnees', 'analyste de donnees', 'architecte de donnees', 'gestion des donnees',
  'gouvernance des donnees', 'base de donnees', 'bases de donnees', 'entrepot de donnees', 'donnees massives',
  'decisionnel', 'decisionnelle', 'business intelligence', 'intelligence artificielle', 'machine learning',
  'apprentissage automatique', 'cybersecurite', 'cyber', 'cybersecurity', 'securite informatique',
  'securite des systemes d information', 'pentest*', 'risque informatique', 'risques informatiques',
  // Projets informatiques et SI métier
  'chef de projet informatique', 'chef de projet technique', 'cheffe de projet informatique', 'product owner',
  'product manager', 'proxy po', 'scrum', 'agile', 'maitrise d ouvrage', 'business analyst', 'analyste fonctionnel*',
  'analyste metier', 'consultant fonctionnel', 'consultante fonctionnelle', 'erp', 'sap', 'oracle', 'workday',
  'salesforce', 'sirh', 'crm',
  // Métiers du numérique
  'web*', 'internet', 'intranet', 'site internet', 'application mobile', 'applications mobiles',
  'ux', 'ui', 'ergonome', 'ux designer', 'designer ux',
]

/**
 * Sigles reconnus seulement écrits en majuscules (« SI », pas « si ») : en minuscules, plusieurs sont des mots
 * courants. Un intitulé entièrement en capitales peut en contenir par hasard, le risque est accepté.
 */
const IT_ACRONYMS = /\b(SI|DSI|IT|IA|AI|BI|ERP|SAP|SIRH|SIG|SSI|RSSI|SOC|MOA|MOE|AMOA|PMO|UX|UI|QA|SRE|DBA|PO|CRM|API|ETL|TMA|CTO|CIO)\b/

/**
 * Vocabulaire du bâtiment, qui l'emporte sur les expressions et sigles : la maîtrise d'ouvrage (MOA) y désigne le
 * donneur d'ordre des travaux (« Appui à la maîtrise d'ouvrage déléguée pour le suivi des travaux de réhabilitation »,
 * relevé chez Expertise France), et les travaux sont hors périmètre même informatiques (câblage).
 */
const CONSTRUCTION_PHRASES = ['travaux', 'maitrise d ouvrage deleguee']

/** Le texte parle-t-il d'informatique (expressions, sigles en majuscules) hors du bâtiment ? */
export function mentionsIt(text: string): boolean {
  const normalized = normalize(text)
  if (CONSTRUCTION_PHRASES.some((phrase) => containsPhrase(normalized, phrase))) return false
  if (IT_ACRONYMS.test(text)) return true
  return IT_PHRASES.some((phrase) => containsPhrase(normalized, phrase))
}

/** Appel d'offres de services informatiques ou de logiciels. */
export function isItTender(listing: Pick<Listing, 'title' | 'cpv' | 'descriptors'>): boolean {
  const cpv = (listing.cpv ?? []).map((code) => code.replace(/\D/g, '')).filter(Boolean)
  const descriptors = (listing.descriptors ?? []).map(normalize)
  if (cpv.some((code) => IT_CPV_PREFIXES.some((prefix) => code.startsWith(prefix)))) return true
  if (descriptors.some((descriptor) => IT_BOAMP_DESCRIPTORS.has(descriptor))) return true
  // Classé hors informatique par l'acheteur ou le BOAMP : la classification l'emporte sur les mots de l'intitulé.
  if (cpv.length || descriptors.length) return false
  return mentionsIt(listing.title)
}

/** Offre d'emploi d'un métier informatique ou numérique, d'après son intitulé et sa catégorie (domaine, département). */
export function isItJob(listing: Pick<Listing, 'title' | 'details'>): boolean {
  return mentionsIt([listing.title, ...listing.details].join(' \n '))
}

export function isItListing(listing: Listing): boolean {
  return listing.kind === 'tender' ? isItTender(listing) : isItJob(listing)
}

/**
 * Lecture d'une source réduite aux offres informatiques : les autres passent dans `ignoredIds` (retenues comme vues,
 * jamais envoyées), si bien que le nombre d'annonces lues, qui sert à repérer une source qui se vide, ne change pas.
 * Élargir le périmètre plus tard ne renverra pas ces offres-là (voir README, « Périmètre informatique »).
 */
export function scopeToIt(batch: SourceBatch): { batch: SourceBatch; outOfScope: string[] } {
  const listings: Listing[] = []
  const outOfScope: string[] = []
  for (const listing of batch.listings) {
    if (isItListing(listing)) listings.push(listing)
    else outOfScope.push(listing.id)
  }
  return { batch: { ...batch, listings, ignoredIds: [...batch.ignoredIds, ...outOfScope] }, outOfScope }
}
