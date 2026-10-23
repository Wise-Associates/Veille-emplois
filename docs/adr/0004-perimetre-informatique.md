# 0004 — Périmètre informatique : seules les offres informatiques sont envoyées

Date : 23 octobre 2026 · Statut : acceptée (complète l'ADR 0003)

## Contexte

La veille envoyait toutes les offres des organismes suivis : environ 780 en ligne en octobre 2026, dont une grande
majorité hors du métier de Wise Associates (travaux et entretien de bâtiments, huissiers, comptables publics,
juristes, analystes crédit…). Chaque offre envoyée coûte un e-mail (quota horaire d'IONOS), une lecture par l'IA de
MyBestConsultant et une validation par un administrateur. La demande : n'envoyer que les projets informatiques.

Périmètre choisi le 23/10/2026 :

- **appels d'offres** : services informatiques et logiciels (conseil, développement, intégration, TMA, hébergement,
  progiciels), sans le matériel, la maintenance de serveurs et réseaux, les télécommunications ni les travaux ;
- **offres d'emploi** : métiers techniques (développement, DevOps, systèmes et réseaux, support), données / IA /
  cybersécurité, projets informatiques et SI métier (chef de projet, MOA, business analyst, ERP, SI financiers),
  métiers du numérique (UX/UI, web, transformation numérique).

## Décision

1. **Appels d'offres jugés sur leur classification** : codes CPV 72 et 48 (BOAMP : `donnees`, eForms et formulaires
   nationaux ; TED : `classification-cpv`), ou descripteurs BOAMP « Informatique (prestations de services) » et
   « Logiciel ». La classification, choisie par l'acheteur, l'emporte sur l'intitulé (« postes informatiques » en
   CPV 30 : matériel, écarté). Seul un avis sans aucune classification est jugé sur son intitulé.
2. **Offres d'emploi jugées sur leur intitulé et leur catégorie** (domaine Choisir le service public, département
   Expertise France), jamais sur le texte complet : « maîtrise des outils bureautiques » ou « environnement digital »
   y figurent dans presque toutes les offres. Expressions sans accents ni majuscules ; sigles seulement en
   majuscules ; mots ambigus seulement dans une expression ; vocabulaire du bâtiment prioritaire.
3. **Règles explicites dans le code** (`src/it-scope.ts`), testées, plutôt qu'une classification par IA : le résultat
   est reproductible, gratuit, vérifiable sans IA, et la veille reste sans clé d'API. MyBestConsultant garde son IA
   pour l'extraction, sur 5 fois moins d'offres.
4. **Une offre écartée est retenue comme vue** (`ignoredIds`) : elle n'est pas réexaminée à chaque passage, et le
   nombre d'annonces lues, qui sert aux alertes de volume, ne change pas. Elle est comptée dans le récapitulatif
   (« hors projets informatiques »).

## Conséquences

- Mesure du 23/10/2026 (TED injoignable ce jour-là) : 151 offres gardées sur 782 (19 %) ; 2 appels d'offres sur 22
  au BOAMP. Le premier passage tient dans le plafond, et le quota horaire d'IONOS n'est plus un problème.
- Faux positifs acceptés : offres d'Expertise France liées à un programme d'« économie numérique » ou à un ministère
  « de la Transformation numérique » sans être des métiers informatiques ; sigle CRM d'un autre sens (« matières
  premières critiques »). Faux négatifs acceptés : intitulé sans aucun mot informatique (« Ingénieur d'études » sans
  précision, projet nommé par l'adresse de son site), appel d'offres mal classé par l'acheteur.
- **Élargir le périmètre ne rattrape pas les offres déjà écartées** : il faut supprimer la clé de la source dans
  `etat.json` (toutes ses offres en ligne repartent ; MyBestConsultant dédoublonne celles déjà reçues sur 60 jours).
- Les offres hors informatique envoyées avant cette décision restent dans MyBestConsultant : un administrateur les
  rejette depuis la page AO.
- Toute modification des règles se vérifie sur les offres réelles (`npm run veille:essai`) avant d'être déployée.
