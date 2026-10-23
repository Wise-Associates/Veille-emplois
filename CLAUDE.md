# Veille marchés et emplois — règles du projet

Lire d'abord le [README](README.md) et les ADR de `docs/adr/`.

## Pile et commandes

- NestJS 12 (ESM uniquement) en **contexte d'application autonome**, sans serveur HTTP. TypeScript 6, Node 22.12+.
- Imports relatifs **avec l'extension `.js`** (ESM `nodenext`), `import type` pour les types (`verbatimModuleSyntax`).
- `npm run typecheck`, `npm test` (compile par `tsc` dans `dist-test/` puis `node --test`), `npm run build`,
  `npm run veille:essai` (lecture réelle des sources, sans envoi ni enregistrement : la vérification de bout en bout).
- Tests : `node:test` + `node:assert/strict`, fichiers `*.spec.ts` à côté du code, noms en français. Ne pas passer à
  Vitest ni Jest sans relire l'ADR 0002 (plantage de npm 10.9, Node 24.9+ pour Jest).
- Dépendances figées (`--save-exact`), versions publiées depuis au moins deux semaines.

## Règles

- Identifiants de code en anglais, commentaires, messages, journaux et e-mail en français.
- **Données fictives uniquement** dans les tests et aperçus (titres, identifiants, noms).
- Les avis de marché contiennent des **contacts nominatifs** : ne lire que le nom et le SIRET de l'acheteur, ne jamais
  les journaliser ni les envoyer.
- **Respecter les conditions d'usage des sites** (ADR 0001) : API et flux officiels d'abord ; pages publiques
  seulement si robots.txt les autorise ; User-Agent `veille-marches-emplois` ; jamais se faire passer pour un
  navigateur, contourner un blocage ou lire PLACE / lasecurecrute.fr (interdits sans autorisation écrite).
- L'`id` d'une source est sa clé dans le fichier d'état : ne jamais le renommer (toutes ses offres en ligne
  repartiraient vers la boîte AO).
- Une offre par e-mail vers la boîte AO de MyBestConsultant (ADR 0003) : garder les libellés de
  `src/digest/offer-email.ts` (« Client », « Lieu », « Date limite… »), lus par sa consigne d'extraction. Une offre
  n'est retenue comme envoyée qu'après acceptation par le serveur SMTP (`forgetUnsent`).
- L'en-tête `X-Wise-Veille: scraping` (`VEILLE_HEADER`) est lu par MyBestConsultant (`src/lib/ao/imap.ts`,
  `fromVeille`) : ne jamais le renommer sans changer les deux projets.
- `npm run veille:local` envoie réellement : pour tester, une boîte de test dans `OFFERS_TO`.
- Les liens d'offres présentés dans l'e-mail doivent pointer vers le site de l'organisme : chaque source vérifie
  l'hôte et lève une erreur sinon (lien d'hameçonnage depuis un site compromis).
- Une offre d'un autre organisme (ex. AFD hors Proparco) n'est mise dans `ignoredIds` (retenue comme vue pour toujours)
  que sur une réponse explicite de la source ; dans le doute, lever une erreur ou laisser l'offre inconnue.
- Une source qui ne comprend plus la page **lève une erreur** (signalée dans le récapitulatif) au lieu de renvoyer
  une liste vide ; valider les réponses JSON avec zod (`HttpClient.json`).
- Seules les offres informatiques sont envoyées (ADR 0004, `src/it-scope.ts`) : toute règle de périmètre s'accompagne
  d'un cas dans `src/it-scope.spec.ts` (y compris le faux positif à écarter) et d'une vérification sur les offres
  réelles (`npm run veille:essai`). Une offre écartée est retenue comme vue : élargir ne la renverra pas.
- Toute règle de reconnaissance d'acheteur (`src/organisations.ts`) s'accompagne d'un cas dans
  `src/tenders/buyer-match.spec.ts`, y compris les homonymes à écarter.
- Le workflow `veille-quotidienne.yml` n'utilise que des secrets, la variable `MAX_OFFER_EMAILS_PER_RUN`, l'entrée
  booléenne `essai` et `DIGEST_MODE` (calculé d'après l'horaire du passage), tous passés par `env:` (jamais `${{ }}`
  dans un script). Changer l'horaire de 5 h oblige à changer aussi l'expression de `DIGEST_MODE`.
  Le job qui exécute le code (`passage`) garde un jeton en lecture seule ; seul `enregistrer`, qui n'exécute que git,
  peut écrire. Actions épinglées par SHA (version en commentaire).
