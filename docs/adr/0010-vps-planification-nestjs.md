# 0010 — La veille sur le VPS : planificateur NestJS, état sur disque

Date : 5 novembre 2026 · Statut : acceptée (remplace, à la bascule, la planification et l'état de l'ADR 0002 ; la
lecture de la boîte AO de l'ADR 0008 passe dans l'application)

## Contexte

La veille tournait dans GitHub Actions (ADR 0002) : quatre lancements par jour, état sur la branche Git
`veille-etat`, ticket ouvert en cas d'échec, lecture de la boîte AO par un job à part qui n'exécutait que curl
(ADR 0008). Demande du 05/11/2026 : la faire tourner sur un VPS. Choix de l'utilisateur le même jour :

- **le serveur de MyBestConsultant** (Hetzner, Ubuntu 24.04, Docker, utilisateur `deploy`, ADR 0027 de
  MyBestConsultant), plutôt qu'un serveur à part ;
- **les passages planifiés par NestJS** (`@nestjs/schedule`) dans un conteneur qui reste lancé, plutôt que la crontab
  du serveur lançant un conteneur par passage (solution proposée, plus simple : processus neuf à chaque passage, codes
  de sortie inchangés, verrou du noyau avec `flock`, secret de MyBestConsultant hors de l'application) ;
- **le déploiement par GitHub Actions et SSH**, comme MyBestConsultant, plutôt qu'une construction sur le serveur.

## Décision

1. **Un conteneur** (`Dockerfile`, `deploy/compose.yml`) lancé par `node dist/main.js --schedule` : planification
   `@nestjs/schedule` 12.0.2 (module officiel de NestJS, licence MIT, dépendance `cron` épinglée par lui), aux mêmes
   heures qu'avant, en UTC (`src/run/veille-scheduler.ts`). Le passage de 5 h envoie toujours le récapitulatif, les
   autres seulement s'il y a un point à vérifier (ce que faisait `DIGEST_MODE` dans le workflow). Un passage planifié
   est sauté si le précédent n'est pas fini. Conteneur durci : système de fichiers en lecture seule, aucun privilège,
   aucun port publié, 512 Mo au plus, journal limité, utilisateur uid 10001 sans compte sur le serveur (l'uid 1000 de
   l'image Node y est en général le premier compte d'administration).
2. **Un passage à la fois, y compris lancé à la main** (`docker exec veille node dist/main.js`) : verrou
   `etat.json.lock`, mis en place d'un seul coup (contenu écrit à part, puis `link`, qui échoue s'il existe :
   `StateStore.acquireRunLock`). Un passage refusé ne fait rien. Un verrou de plus de deux heures, illisible ou daté
   dans le futur est repris : un passage dure moins d'une heure. Au démarrage du conteneur planifié, un verrou encore
   là vient forcément d'un passage tué net (aucun passage ne survit au conteneur) : il est retiré et l'équipe prévenue
   (revue du 05/11/2026 : sinon les passages des deux heures suivantes, récapitulatif du matin compris, étaient
   refusés en silence).
3. **Arrêt du conteneur** (déploiement, redémarrage) : plus aucun passage n'est lancé, celui en cours va au bout
   (`beforeApplicationShutdown`, `stop_grace_period: 35m`), sans nouvel appel à MyBestConsultant. Sans cela, ses offres
   déjà envoyées ne seraient pas retenues et repartiraient. La connexion SMTP n'est fermée qu'à la toute fin
   (`Mailer.onApplicationShutdown`) : NestJS appelle `onModuleDestroy` avant `beforeApplicationShutdown`, et une
   fermeture à ce moment-là faisait échouer les offres en file (revue du 05/11/2026). Le script de déploiement refuse
   tout de suite un déploiement pendant un passage plutôt que d'attendre.
4. **État sur le disque du serveur** (`/opt/veille-marches-emplois/donnees`, monté sur `/data`) ; une copie par jour
   gardée 30 jours (`historique/`), à la place de l'historique de la branche Git. Une copie impossible est signalée
   dans le récapitulatif sans arrêter le passage. La copie hors du serveur relève de ses sauvegardes (Hetzner).
5. **Alerte par e-mail** à `MAIL_TO` quand un passage échoue (interrompu, envoi incomplet, lecture de la boîte AO
   refusée), à la place du ticket GitHub (`src/run/veille-runner.ts`, `src/digest/alert-email.ts`). Si le serveur
   d'envoi est lui-même en panne, seul le journal le dit ; l'absence du récapitulatif de 5 h reste le signal.
6. **Lecture de la boîte AO par l'application** (`src/run/ao-inbox-sync.ts`), même déroulé que le job `synchroniser` :
   30 s d'attente, rappels tant qu'il reste des e-mails, 15 minutes au plus, secret envoyé à la même adresse seulement.
   Conséquence acceptée : le `CRON_SECRET` de MyBestConsultant (`AO_SYNC_TOKEN`) est désormais lu par le processus
   Node et ses dépendances npm, comme les autres secrets du conteneur (mot de passe SMTP, jeton des réglages). Le job
   à part le protégeait de ces dépendances ; sur le serveur, les isoler demanderait un second conteneur.
7. **Déploiement** (`.github/workflows/deploy-vps.yml`, lancé à la main depuis `main`) : un job sans secret vérifie le
   code (types, tests), un job de l'environnement `production` construit l'image et l'envoie par SSH à
   `deploy/veille-deploy.sh`, seule commande permise à sa clé. Clés propres à la veille (lecture du dépôt,
   déploiement) : GitHub n'accepte une clé de déploiement que sur un dépôt, et une clé SSH par commande permise. Cinq
   images gardées pour un retour arrière.
8. **Le script de déploiement est la barrière du serveur partagé** (revue de sécurité du 05/11/2026). Sa copie
   installée (`/usr/local/bin`, propriété de root) ne vient pas du commit déployé. Il n'accepte :
   - qu'un commit de `main` ;
   - qu'une archive d'**une seule image**, celle annoncée, vérifiée **avant** `docker load` (qui sinon donnerait à
     d'autres images les noms qu'elle contient, ceux des images gardées de MyBestConsultant compris) et bornée à 1 Go ;
   - qu'un `deploy/compose.yml` de la forme attendue (`check_compose` : liste fermée de réglages, utilisateur 10001,
     lecture seule, aucune capacité, seul le dossier d'état monté, aucun port ni réseau de l'hôte), vérifié avant
     chaque démarrage. Un commit de `main` ne peut donc pas donner au conteneur l'accès au serveur ;
   - qu'un verrou de passage daté dans les deux dernières heures comme raison de refuser (un verrou écrit par le
     conteneur ne peut pas bloquer un retour arrière).

   La remise de l'état d'un jour (`veille-deploy restore`) copie le fichier dans un conteneur, sous l'utilisateur de
   la veille : un lien symbolique posé par le conteneur dans son dossier ne peut pas faire copier par root un fichier
   du serveur. Côté GitHub, `main` protégé (pull request approuvée, pas de poussée forcée) et l'environnement
   `production` avec validation par une seconde personne sont obligatoires (guide, partie 3).
9. **Envoi des e-mails sur le port 587** : Hetzner bloque par défaut les ports sortants 25 et 465.

## Conséquences

- Bascule dans un ordre précis (guide, partie 4) : ancien workflow désactivé, état copié de la branche `veille-etat`,
  puis déploiement. Deux veilles en même temps enverraient chaque offre deux fois ; un VPS sans l'état renverrait
  toutes les offres en ligne. L'ancien workflow et ses secrets sont retirés une semaine après.
- Jusqu'à la bascule, l'ancien workflow lance le code de `main` comme avant (`node dist/main.js`). Il pose aussi le
  verrou et envoie l'alerte e-mail en cas d'échec, en plus du ticket. Il ne fait pas lire la boîte AO par
  l'application (ni `AO_SYNC_URL` ni `AO_SYNC_TOKEN` dans son job `passage`) : son job `synchroniser` continue de le
  faire.
- Un redémarrage du conteneur à l'heure exacte d'un passage le fait sauter ; ses offres partent au suivant.
- Le conteneur ne prend une nouvelle valeur de `veille.env` qu'après `veille-deploy restart`.
- Le même défaut (chargement de l'image avant sa vérification) existe dans `deploy/mbc-deploy.sh` de
  MyBestConsultant : à corriger de la même façon dans ce dépôt-là.
- Guide d'installation et d'exploitation : `docs/deploiement-vps.md`.
