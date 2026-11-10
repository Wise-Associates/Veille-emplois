# Veille marchés et emplois — règles du projet

Lire d'abord le [README](README.md) et les ADR de `docs/adr/`.

## Pile et commandes

- NestJS 12 (ESM uniquement) en **contexte d'application autonome**, sans serveur HTTP. TypeScript 6, Node 22.13+
  (`pdfjs-dist`).
- Imports relatifs **avec l'extension `.js`** (ESM `nodenext`), `import type` pour les types (`verbatimModuleSyntax`).
- `npm run typecheck`, `npm test` (compile par `tsc` dans `dist-test/` puis `node --test`), `npm run build`,
  `npm run veille:essai` (lecture réelle des sources, sans envoi ni enregistrement : la vérification de bout en bout).
- Production : **VPS de MyBestConsultant** (ADR 0010, guide `docs/deploiement-vps.md`), conteneur toujours lancé
  (`node dist/main.js --schedule`, planificateur `@nestjs/schedule`). Image : `Dockerfile` ; conteneur :
  `deploy/compose.yml` ; déploiement : workflow « Déployer sur le VPS » → `deploy/veille-deploy.sh`.
- Tests : `node:test` + `node:assert/strict`, fichiers `*.spec.ts` à côté du code, noms en français. Ne pas passer à
  Vitest ni Jest sans relire l'ADR 0002 (plantage de npm 10.9, Node 24.9+ pour Jest).
- Dépendances figées (`--save-exact`), versions publiées depuis au moins deux semaines.

## Règles

- Identifiants de code en anglais, commentaires, messages, journaux et e-mail en français.
- **Données fictives uniquement** dans les tests et aperçus (titres, identifiants, noms).
- Les avis de marché contiennent des **contacts nominatifs** : ne lire que le nom et le SIRET de l'acheteur, ne jamais
  les journaliser ni les écrire dans un e-mail. Seule exception (ADR 0009, accord de l'utilisateur) : l'avis officiel en
  PDF, joint tel quel à l'e-mail de la boîte AO ; son texte n'est lu, en mémoire, que pour la ligne de date limite d'un
  appel d'offres qui n'en a pas (ADR 0011, `src/tenders/notice-deadline.ts`), rien d'autre gardé ni journalisé.
- **Avis officiel en PDF** (ADR 0009, `src/tenders/notice-pdf.ts`) : téléchargé seulement depuis `www.boamp.fr` et
  `ted.europa.eu` (https, redirections comprises), à une adresse construite à partir de l'identifiant de l'avis ; un
  échec n'empêche pas l'envoi (signalé), et un message refusé avec son PDF est renvoyé aussitôt sans lui. Le dossier de
  consultation (DCE) des plateformes d'acheteurs n'est **jamais téléchargé** (connexion, conditions d'usage) : seul son
  lien est donné dans l'e-mail, filtré par `webUrl` (lien saisi par un tiers).
- **Date limite d'un appel d'offres** (ADR 0011) : celle du dernier avis rectificatif s'il en donne une (il peut la
  repousser), sinon `datelimitereponse` du BOAMP, sinon les périodes eForms de l'avis (`boampDeadline`,
  `boampEformsDeadline`), la plus proche encore à venir (`pickDeadline` : jamais un avis écarté pour un lot clos), sinon la ligne « Date limite de réception des offres / demandes de participation » de
  l'avis PDF, téléchargé alors avant le contrôle des offres échues puis joint (`prepare`, `scan.service.ts`). Si le
  BOAMP ou TED changent ce libellé, adapter `DEADLINE_LINE` et son test (`notice-deadline.spec.ts`).
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
- **Organismes, sources et filtre informatique sont des réglages** (ADR 0005) : modifiés dans l'admin de
  MyBestConsultant, lus au début de chaque passage (`src/settings/`), avec repli sur la dernière version connue puis
  sur `config/defaults.json`. Le format (`src/settings/veille-settings.ts`) est le même que celui de MyBestConsultant
  (`src/lib/veille/config.ts`, même `schemaVersion`) : toute évolution se fait dans les deux projets. Les expressions
  des réglages sont normalisées (`normalizePhrase`, `src/phrases.ts`) avant tout usage : elles ne contiennent alors que
  `[a-z0-9 *]` et peuvent entrer dans une requête BOAMP ou une expression régulière.
- Un appel d'offres n'est envoyé que si **deux indices concordent** (ADR 0007, `isItTender`) : code CPV **principal**
  informatique (à défaut de code, descripteur du BOAMP) et mot-clé dans l'**intitulé** (pour un organisme suivi, le
  vocabulaire du filtre informatique compte aussi). Jamais un code CPV secondaire ni la description : ils ont fait
  envoyer des imprimantes et des matériels de cuisine. Ne pas assouplir sans mesure sur les avis ouverts.
- Les appels d'offres sont aussi cherchés **chez tous les acheteurs**, par mots-clés (ADR 0006,
  `src/tenders/all-buyers.ts`) : seulement dans l'intitulé (le texte complet des avis contient « dématérialisation »
  partout). Dans TED, jamais un terme seul de moins de trois lettres (il renvoie tous les avis). Avant d'ajouter un
  mot-clé large, mesurer ce qu'il ramène sur les avis ouverts (`npm run veille:essai`).
- Seules les offres informatiques sont envoyées (ADR 0004) : toute évolution de la **logique** du périmètre
  (`src/it-scope.ts`) ou de la reconnaissance d'acheteur (`src/tenders/buyer-match.ts`) s'accompagne d'un cas dans
  leur `*.spec.ts` (y compris le faux positif ou l'homonyme à écarter) et d'une vérification sur les offres réelles
  (`npm run veille:essai`). Une offre écartée est retenue comme vue : élargir ne la renverra pas.
- **VPS** (ADR 0010) :
  - heures des passages : `MORNING_RUN` / `DAY_RUNS` de `src/run/veille-scheduler.ts`, en UTC ; le passage du matin
    envoie toujours le récapitulatif. Un changement d'heure se reporte dans le README et le guide.
  - un passage, planifié ou à la main (`docker exec veille node dist/main.js`), passe par `VeilleRunner` : verrou du
    fichier d'état (`acquireRunLock`, jamais deux passages), lecture de la boîte AO, alerte e-mail en cas d'échec. Ne
    jamais lancer `ScanService.run()` en dehors de lui en production.
  - à l'arrêt du conteneur, le passage en cours va au bout (`beforeApplicationShutdown`) : ne pas baisser
    `stop_grace_period` de `deploy/compose.yml` sous la durée maximale d'un passage (budget de 25 minutes, plus
    l'enregistrement, le récapitulatif et un appel à MyBestConsultant).
  - `deploy/compose.yml` : jamais de `ports:`, de privilège ni de volume en plus ; `check_compose` de
    `deploy/veille-deploy.sh` refuse tout réglage hors de sa liste (changer l'un oblige à changer l'autre, après
    relecture). Les chemins du serveur viennent de ce script (une seule définition). Un changement de
    `veille-deploy.sh` doit être réinstallé sur le serveur (guide, partie 5). Le conteneur tourne sous l'uid 10001
    (Dockerfile, compose.yml, `APP_USER` du script : les trois ensemble).
  - le dossier d'état est écrit par le conteneur : sur le serveur, jamais de `sudo cp` / `sudo install` depuis ce
    dossier (liens symboliques) ; `veille-deploy restore <jour>` pour l'historique, `sudoedit` pour une modification.
  - la connexion SMTP se ferme dans `Mailer.onApplicationShutdown`, jamais dans `onModuleDestroy` (appelé par NestJS
    avant `beforeApplicationShutdown`, il couperait l'envoi d'un passage en cours).
  - nouvelle variable d'environnement : `.env.example`, `src/config.ts` et la liste du guide (2.4) ; un humain
    l'ajoute à `/etc/veille-marches-emplois/veille.env` avant le déploiement du code qui la lit.
  - SMTP sur le port 587 : Hetzner bloque par défaut les ports sortants 25 et 465.
- Le workflow `veille-quotidienne.yml` (ancien fonctionnement, retiré une semaine après la bascule sur le VPS ; ne
  jamais le réactiver ensuite) n'utilise que des secrets (dont `VEILLE_CONFIG_URL`, `VEILLE_CONFIG_TOKEN`,
  `AO_SYNC_URL` et `AO_SYNC_TOKEN`),
  la variable `MAX_OFFER_EMAILS_PER_RUN`, l'entrée booléenne `essai` et `DIGEST_MODE` (calculé d'après l'horaire du
  passage), tous passés par `env:` (jamais `${{ }}` dans un script). Changer l'horaire de 5 h oblige à changer aussi l'expression de `DIGEST_MODE`.
  Le job qui exécute le code (`passage`) garde un jeton en lecture seule ; seul `enregistrer`, qui n'exécute que git,
  peut écrire. `AO_SYNC_TOKEN` (le `CRON_SECRET` de MyBestConsultant) n'est donné qu'au job `synchroniser`, qui
  n'exécute que curl (ADR 0008) : jamais au job `passage`, dont les dépendances npm le liraient. Sur le VPS, ce secret
  est dans le conteneur (risque accepté, ADR 0010). Actions épinglées par SHA (version en commentaire), dans tous les
  workflows ; `deploy-vps.yml` : le job qui détient la clé SSH n'exécute aucun code du dépôt hors du build Docker.
