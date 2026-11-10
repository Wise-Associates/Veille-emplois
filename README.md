# Veille marchés et emplois

Chaque matin, les **nouveaux appels d'offres** et les **nouvelles offres d'emploi** de 14 organismes publics et
parapublics partent, **une offre par e-mail** avec son texte complet, vers la boîte AO de MyBestConsultant, qui les
traite comme les autres appels d'offres reçus (lecture par l'IA, offres « à valider », publication par un
administrateur). L'équipe reçoit en plus un récapitulatif quotidien.

Organismes : DGFiP (et son réseau régional et départemental pour les marchés), DINUM, INSEE, ASP, APE, Urssaf Caisse
nationale (ACOSS), CNAM, UCANSS (marchés), La Banque Postale, SFIL, CRH, Cour des comptes, Autorité de la concurrence,
Proparco, Expertise France. Pour les appels d'offres, la veille cherche aussi chez **tous les acheteurs publics**, par
mots-clés (SaaS, digitalisation, données, IA, TMA…, voir « Périmètre informatique »).

- Appels d'offres : BOAMP et TED (Journal officiel de l'UE), par leurs API officielles.
- Offres d'emploi : Choisir le service public (flux RSS) et les sites carrières des organismes.
- Détail des sources, de leurs conditions d'usage et des sources écartées (PLACE, offres Urssaf / CNAM) :
  [docs/adr/0001-sources-et-contraintes.md](docs/adr/0001-sources-et-contraintes.md).
- Pourquoi une offre par e-mail, et ce qu'il faut vérifier avant de publier :
  [docs/adr/0003-une-offre-par-e-mail-vers-la-boite-ao.md](docs/adr/0003-une-offre-par-e-mail-vers-la-boite-ao.md).

## Fonctionnement

1. Un passage démarre quatre fois par jour : 5 h, 9 h, 13 h et 17 h UTC. Sur le VPS, c'est le planificateur de
   l'application (`src/run/veille-scheduler.ts`, conteneur toujours lancé, voir « Mise en production ») ; avant la
   bascule, c'était le workflow GitHub `Veille quotidienne`. Jamais deux passages en même temps (verrou du fichier
   d'état).
2. Chaque source est lue l'une après l'autre (5 minutes environ). Une source en panne n'empêche pas les autres.
3. Une annonce est **nouvelle** si son identifiant n'a jamais été envoyé depuis sa source (fichier `etat.json`, voir
   « État de la veille »). Les sources d'offres d'emploi donnent toutes leurs offres
   en ligne ; pour les appels d'offres, ce sont **tous les avis encore ouverts** (date limite de réponse non passée,
   publiés depuis 120 jours) : le premier passage envoie tout ce à quoi on peut encore répondre, et un passage manqué
   est rattrapé tant que l'avis est ouvert.
4. Seules les offres **informatiques** sont envoyées (voir « Périmètre informatique ») : les autres sont retenues
   comme vues, jamais envoyées, et comptées dans le récapitulatif (« hors projets informatiques »).
5. Chaque nouvelle offre part dans **son propre e-mail** vers la boîte AO (`OFFERS_TO`) : intitulé, client
   (l'organisme ; pour un acheteur non suivi, l'acheteur lui-même), lieu, précisions, dates, référence, lien, puis le texte complet. Quand la liste de la source ne
   donne pas tout, la page de l'offre est lue au moment de l'envoyer (Choisir le service public : employeur exact et
   date limite ; Expertise France et La Banque Postale : texte de l'offre). Un appel d'offres du BOAMP ou de TED part
   avec **l'avis officiel en PDF en pièce jointe**, téléchargé au moment de l'envoyer, et le **lien du dossier de
   consultation** de l'acheteur (DCE), qui n'est jamais téléchargé (voir
   [docs/adr/0009-avis-pdf-joint-et-lien-du-dossier-de-consultation.md](docs/adr/0009-avis-pdf-joint-et-lien-du-dossier-de-consultation.md)).
6. Au plus `MAX_OFFER_EMAILS_PER_RUN` offres par passage (200 par défaut), une par seconde, et aucune nouvelle offre
   commencée après 25 minutes de passage ; appels d'offres d'abord. Les autres attendent le passage suivant.
   **Le premier passage** trouve toutes les offres informatiques en ligne (435 le 27/10/2026, dont environ 390
   appels d'offres de tous les acheteurs) : elles partent en trois passages, ou plus vite en relançant le workflow à
   la main.
7. Une offre dont la date limite est déjà passée (souvent connue par la page de l'offre) n'est pas envoyée ; elle est
   retenue comme traitée et comptée dans le récapitulatif. Avis européen du BOAMP sans date limite dans l'API : celle
   de ses données eForms ; appel d'offres encore sans date : celle écrite dans son avis officiel en PDF, lu pour cette
   seule ligne (voir [docs/adr/0011-date-limite-des-avis-eforms-puis-pdf.md](docs/adr/0011-date-limite-des-avis-eforms-puis-pdf.md)).
8. Une offre n'est retenue comme envoyée qu'une fois son e-mail accepté par le serveur : si le serveur refuse
   (quota, adresse), l'envoi s'arrête et le reste part au passage suivant ; s'il refuse un seul message (contenu),
   celui-ci est sauté, signalé, et retenté au passage suivant.
9. Un **récapitulatif** part ensuite vers l'équipe (`MAIL_TO`) : offres envoyées, offres en attente, points à
   vérifier. Le passage de 5 h l'envoie **toujours, même sans nouveauté** (son arrivée prouve que la veille tourne) ;
   ceux de 9 h, 13 h et 17 h seulement s'il y a un point à vérifier.
10. **MyBestConsultant lit aussitôt la boîte AO**
    ([docs/adr/0008-lecture-de-la-boite-ao-apres-chaque-passage.md](docs/adr/0008-lecture-de-la-boite-ao-apres-chaque-passage.md)) :
    la veille appelle sa route `/api/cron/ao-inbox` (`AO_SYNC_URL`), et la rappelle tant qu'il reste des e-mails,
    pendant 15 minutes au plus. Les offres envoyées y apparaissent sans attendre son passage quotidien.
11. **Un passage en échec prévient l'équipe** par e-mail (`MAIL_TO`) : cause, état enregistré ou non, marche à
    suivre (`src/digest/alert-email.ts`).

Le récapitulatif signale en tête les **points à vérifier** :

- envoi des offres interrompu (serveur SMTP) ;
- lecture impossible : site en panne, page ou API dont le format a changé, lien d'offre vers un site inattendu ;
- nombre d'offres d'emploi qui s'effondre (vidé, ou divisé par plus de deux) : l'alerte revient **chaque jour**
  jusqu'à ce que la source retrouve son volume ; pendant ce temps, rien n'est oublié de ce qu'elle avait montré ;
- aucun appel d'offres depuis trois semaines (requête BOAMP / TED devenue invalide) ;
- avis BOAMP au contenu illisible, offres envoyées sans le détail de leur page ou sans l'avis officiel en PDF
  (téléchargement impossible), appels d'offres sans date limite dont l'avis PDF n'a pas pu être lu, offres AFD dont
  l'examen est reporté ;
- réglages de MyBestConsultant indisponibles ou invalides (repli sur la dernière version connue ou sur
  `config/defaults.json`, voir « Réglages »), ou `VEILLE_CONFIG_URL` non défini.

Un appel d'offres publié à la fois au BOAMP et à TED n'est envoyé qu'une fois.

Dans MyBestConsultant, chaque e-mail d'offre porte l'en-tête `X-Wise-Veille: scraping` : la page AO affiche alors
« Scraping » dans la colonne « Source » (au lieu de « E-mails AO »), écarte une offre échue, et dédoublonne avec les
offres reçues par ailleurs (même intitulé, client, ville et contrat sur 60 jours). L'en-tête n'est reconnu que si
l'expéditeur est d'un domaine de l'organisation (voir l'ADR 0008 de MyBestConsultant).

## Périmètre informatique

Décision du 23/10/2026 ([docs/adr/0004-perimetre-informatique.md](docs/adr/0004-perimetre-informatique.md)), logique
dans `src/it-scope.ts`, valeurs (codes CPV, descripteurs, expressions, sigles, exclusions) dans les **réglages**
(voir « Réglages ») :

- **Appels d'offres** (règle du 27/10/2026,
  [docs/adr/0007-appels-d-offres-deux-indices-concordants.md](docs/adr/0007-appels-d-offres-deux-indices-concordants.md)) :
  envoyés seulement si **deux indices concordent** :
  - le **code CPV principal** de l'avis est informatique (CPV 72 « services informatiques », CPV 48 « logiciels et
    systèmes d'information »). Sans code CPV (petits avis du BOAMP), un descripteur « Informatique (prestations de
    services) » ou « Logiciel » en tient lieu. Les codes secondaires ne comptent pas : un achat d'imprimantes en porte
    souvent un « logiciel » ;
  - l'**intitulé** contient un **mot-clé des appels d'offres** (10 familles : SaaS et logiciels, développement,
    refonte et TMA, digitalisation, gouvernance et plateformes de données, BI, IA, conseil SI / AMOA, outils de
    risques et de conformité). Pour un organisme suivi, le vocabulaire du filtre informatique compte aussi. La
    description n'est pas lue.

  Un avis classé hors informatique (matériel, maintenance, formation, conseil…) est écarté, même avec un mot-clé. Sans
  aucune classification, seul un avis d'organisme suivi peut passer, sur son intitulé. Une exclusion (« travaux »…) dans
  l'intitulé écarte l'avis. Un intitulé d'**infrastructure seule** (serveurs, réseau, matériel, antennes relais) sans
  mot-clé aussi.

  **Tous les acheteurs** (réglage activé par défaut) : au BOAMP et dans TED, une recherche par famille de mots-clés dans
  l'intitulé des avis (dans TED, plus les avis classés informatique), revérifiés avec la règle ci-dessus. Sources à part dans
  le récapitulatif et le fichier d'état (« BOAMP — tous les acheteurs », « TED — tous les acheteurs ») : elles ne gardent
  que les acheteurs non suivis, dont les avis partent sous « Autres acheteurs », avec l'acheteur comme client. Les termes
  trop larges de la liste de départ (« assistance à maîtrise d'ouvrage » seul, « refonte » seul, « reporting »…) ont
  été retirés après mesure : voir l'ADR 0006. Mesure du 27/10/2026 : 74 appels d'offres ouverts gardés, tous
  informatiques (ADR 0007).
- **Offres d'emploi** : métiers techniques, données / IA / cybersécurité, projets informatiques et SI métier (MOA,
  business analyst, ERP), métiers du numérique (UX/UI, web), d'après l'intitulé et la catégorie donnée par la source
  (domaine « Numérique » de Choisir le service public, département d'Expertise France). Les sigles (SI, DSI, MOA…) ne
  comptent qu'en majuscules ; les mots ambigus (réseau, architecte, infrastructure, application) seulement dans une
  expression ; le vocabulaire du bâtiment (« travaux », « maîtrise d'ouvrage déléguée ») l'emporte.

Mesure du 23/10/2026 sur les offres en ligne (TED injoignable ce jour-là) : 151 offres informatiques sur 782 (19 %).
Limites connues : des offres d'Expertise France liées à un programme d'« économie numérique » passent sans être des
métiers informatiques ; un intitulé sans aucun mot informatique (« Ingénieur d'études » sans précision, projet nommé
par l'adresse de son site) est écarté.

- **Ajuster les valeurs** (expressions, codes CPV…) : onglets « Filtre informatique » et « Mots-clés des appels
  d'offres » de l'admin de MyBestConsultant,
  pris en compte au passage suivant ; vérifier sur les offres réelles avec `npm run veille:essai` (avec
  `VEILLE_CONFIG_URL` et `VEILLE_CONFIG_TOKEN`), dont le journal donne, par source, le nombre d'annonces informatiques et
  hors informatique. **Changer la logique** (deux indices, sigles en majuscules…) : `src/it-scope.ts`, avec le
  cas dans `src/it-scope.spec.ts`.
- **Élargir le périmètre** ne renvoie pas les offres déjà écartées : elles sont retenues comme vues. Pour les
  rattraper, supprimer la clé de la source dans `sources` d'`etat.json` (voir « État de la veille ») : toutes ses
  offres en ligne repartent, y compris celles déjà envoyées, que MyBestConsultant dédoublonne sur 60 jours.

## Prérequis

- Node.js 22.13 ou plus (24 recommandé, voir `.nvmrc` ; `pdfjs-dist` l'exige) et npm.
- Pour la production : le serveur de MyBestConsultant (Docker), le dépôt GitHub et une boîte e-mail avec accès SMTP
  (port 587), d'un domaine de l'organisation.

## Installation et commandes

```bash
npm ci                  # dépendances (versions figées par package-lock.json)
npm run build           # compile dans dist/
npm run veille:essai    # lit les sources, affiche le récapitulatif et le premier e-mail d'offre ; n'envoie rien
npm run veille:local    # passage complet avec la configuration de .env (copier .env.example)
npm run typecheck       # vérification des types
npm test                # tests (node:test, sur le code compilé dans dist-test/)
```

`npm run veille:essai` utilise `etat/etat.json` s'il existe ; sinon toutes les offres en ligne apparaissent nouvelles.

Attention, `npm run veille:local` **envoie réellement** les offres à `OFFERS_TO` et enregistre l'état dans
`etat/etat.json` : un essai local vers la vraie boîte AO l'alimente, et l'état local n'est pas celui de la production.
Pour un essai d'envoi, mettre une boîte de test dans `OFFERS_TO` et un petit `MAX_OFFER_EMAILS_PER_RUN`.

## Réglages (MyBestConsultant)

Décision du 27/10/2026 ([docs/adr/0005-reglages-dans-mybestconsultant.md](docs/adr/0005-reglages-dans-mybestconsultant.md)).
Les **organismes suivis** (nom, SIREN, noms d'acheteur, exclusions), les **sources** (BOAMP, TED et sites intégrés :
activés ou non ; Choisir le service public : codes d'organisme ; flux RSS de sites carrières) et le **filtre
informatique** et les **mots-clés des appels d'offres** (recherche chez tous les acheteurs) se modifient dans l'admin
de MyBestConsultant (menu « Veille »), qui les enregistre en versions. Chaque
passage les lit au début (`GET /api/veille/config`, jeton `VEILLE_CONFIG_TOKEN`, 15 s, une nouvelle tentative) :

- MyBestConsultant répond : ses réglages, gardés dans `etat.json` (`settings`) comme dernière version connue ;
- il ne répond pas ou renvoie des réglages illisibles : la dernière version connue, signalée dans le récapitulatif ;
- aucune version connue, ou `VEILLE_CONFIG_URL` non défini (essai local) : ceux du dépôt, `config/defaults.json`,
  signalés aussi.

Un organisme désactivé n'est plus suivi (ni ses appels d'offres, ni ses sources). L'identifiant d'une source est sa clé
dans `etat.json` : fixé à sa création, jamais modifié (une source recréée sous un autre identifiant renverrait toutes
ses offres en ligne). Ajouter un site sans flux RSS ni code Choisir le service public demande du code
(`src/sources/`, puis la liste `BUILTIN` de `src/sources/sources.ts` et `BUILTIN_SOURCE_ORGANISATIONS`, dans les deux
projets). `config/defaults.json` (réglages exportés le 27/10/2026, avec la raison des règles particulières, `note`)
sert à charger MyBestConsultant la première fois (`npm run veille:seed` de MyBestConsultant), aux tests et en dernier
recours ; le garder valide (vérifié au démarrage et par `npm test`).

## Configuration

Variables d'environnement, toutes décrites dans [.env.example](.env.example) : `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASSWORD`, `MAIL_FROM`, `OFFERS_TO` (boîte AO), `MAIL_TO` (équipe, adresses séparées par des virgules),
`MAX_OFFER_EMAILS_PER_RUN`, `STATE_FILE`, `VEILLE_CONFIG_URL` et `VEILLE_CONFIG_TOKEN` (facultatifs ; les deux
ensemble, voir « Réglages »), `AO_SYNC_URL` et `AO_SYNC_TOKEN` (facultatifs ; les deux ensemble, lecture de la boîte AO
par MyBestConsultant après le passage). Une variable manquante ou invalide arrête le passage avant toute lecture (le
message nomme la variable, jamais sa valeur). En production, elles sont dans `/etc/veille-marches-emplois/veille.env`
sur le serveur (guide du VPS, 2.4).

- Sur le serveur (Hetzner), `SMTP_PORT` doit être **587** : les ports sortants 25 et 465 y sont bloqués par défaut.

- L'adresse de `MAIL_FROM` doit être celle de la boîte `SMTP_USER`, ou un alias autorisé de cette boîte : la plupart
  des serveurs refusent sinon l'envoi (« 550 Sender address is not allowed »).
- Elle doit aussi être d'un domaine de l'organisation (`@wise-associates.fr`) : MyBestConsultant prend sinon
  l'expéditeur pour le client de toutes les offres, au lieu de l'organisme nommé dans l'e-mail.
- Les serveurs d'envoi limitent les volumes. La veille ouvre une nouvelle connexion tous les 10 messages (IONOS en
  refuse plus de 20 par connexion) et n'envoie qu'un message par seconde. IONOS limite aussi les messages **par
  heure**, selon l'âge de la boîte (« 450 Mail send limit exceeded ») : 50 la première semaine, 100 jusqu'au
  14e jour, 400 jusqu'au 30e, 500 ensuite. Régler `MAX_OFFER_EMAILS_PER_RUN` un peu sous cette limite (place laissée
  au récapitulatif) : 45, puis 90 à partir du 8e jour, puis 200. Avec quatre passages par jour, une file de quelques
  centaines d'offres s'écoule en quelques jours ; les offres non envoyées partent simplement au passage suivant.
- Utiliser une **boîte dédiée** à la veille (ex. `veille@wise-associates.fr`) : la limite horaire est celle de la
  boîte, une boîte partagée bloquerait aussi le courrier de ses utilisateurs.

## Mise en production (VPS)

La veille tourne sur le serveur de MyBestConsultant, dans un conteneur Docker toujours lancé qui fait lui-même ses
passages planifiés ([docs/adr/0010-vps-planification-nestjs.md](docs/adr/0010-vps-planification-nestjs.md)).
Installation, bascule depuis GitHub Actions, exploitation et dépannage :
**[docs/deploiement-vps.md](docs/deploiement-vps.md)**.

- Nouvelle version : fusion dans `main`, puis GitHub → Actions → **« Déployer sur le VPS »** (vérification, image,
  envoi par SSH à `deploy/veille-deploy.sh`, qui remet la version précédente si la nouvelle ne démarre pas).
- Passage tout de suite, essai, journal, retour arrière : guide, partie 5.
- Codes de sortie d'un passage lancé par `node dist/main.js` : 0, passage complet ; 1, passage interrompu avant
  l'enregistrement de l'état, ou un autre passage était en cours ; 3, état enregistré mais un envoi ou la lecture de la
  boîte AO a échoué.
- Le workflow `Vérifications` lance types, tests, compilation et `npm audit` à chaque poussée.

## Ancienne mise en production (GitHub Actions, jusqu'à la bascule)

Le workflow `Veille quotidienne` reste dans le dépôt jusqu'à une semaine après la bascule sur le VPS (guide, partie 4),
puis il est retiré. **Ne jamais le réactiver après la bascule** : il repartirait de l'état ancien de la branche
`veille-etat` et renverrait des offres. Mise en place d'origine, pour mémoire :

1. Pousser ce dépôt sur GitHub (dépôt privé de l'organisation).
2. Dans **Settings → Secrets and variables → Actions**, créer les secrets `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
   `SMTP_PASSWORD`, `MAIL_FROM`, `OFFERS_TO`, `MAIL_TO`, `VEILLE_CONFIG_URL` (`https://<site de production de
   MyBestConsultant>/api/veille/config`) et `VEILLE_CONFIG_TOKEN` (même valeur que dans MyBestConsultant),
   `AO_SYNC_URL` (`https://<site de production de MyBestConsultant>/api/cron/ao-inbox`) et `AO_SYNC_TOKEN` (le
   `CRON_SECRET` de production de MyBestConsultant : à changer ici chaque fois qu'il change dans Vercel) ; facultatif,
   la variable (onglet « Variables ») `MAX_OFFER_EMAILS_PER_RUN`. Sans `AO_SYNC_URL` / `AO_SYNC_TOKEN`, la boîte AO
   n'est lue que par le passage quotidien de MyBestConsultant.
3. Laisser les permissions par défaut des workflows en lecture seule (**Settings → Actions → General**) : chaque job
   déclare lui-même ce dont il a besoin. Ne pas protéger la branche `veille-etat` contre `github-actions[bot]`.
4. Onglet **Actions → Veille quotidienne → Run workflow** : d'abord avec « Essai » coché (récapitulatif et premier
   e-mail d'offre dans le journal), puis sans. Le premier vrai passage crée la branche `veille-etat` et envoie les
   200 premières offres ; relancer le workflow pour envoyer les suivantes plus tôt.
5. Recommandé : protéger la branche `main` (pull request obligatoire) dans **Settings → Rules**.

Le workflow a quatre jobs :
- `passage` exécute la veille avec un jeton **en lecture seule** ;
- `enregistrer`, qui n'exécute que git, pousse l'état sur `veille-etat` ;
- `synchroniser`, qui n'exécute que curl, fait lire la boîte AO par MyBestConsultant (ADR 0008). Il est le seul à
  recevoir `AO_SYNC_TOKEN` ;
- `alerte` ouvre (ou complète) le ticket « Échec de la veille quotidienne » si un passage échoue, ou si
  MyBestConsultant refuse ou ne répond pas. Toutes les personnes qui suivent le dépôt sont prévenues, et le ticket
  renvoie au journal de l'exécution. Le fermer une fois corrigé.

Avec le code de sortie 3, le workflow pousse quand même l'état, pour que les offres déjà envoyées ne repartent pas,
puis ouvre le ticket.

## État de la veille

`etat.json` (sur le VPS : `/opt/veille-marches-emplois/donnees/etat.json` ; avant la bascule : branche `veille-etat`)
retient, pour chaque source, les identifiants déjà envoyés (ou écartés) et la
date à laquelle leur présence a été notée (rafraîchie au plus une fois par mois), le nombre d'annonces de référence,
ainsi que les procédures d'appel d'offres déjà envoyées. Une annonce absente de sa source depuis 90 à 120 jours est
oubliée. Il garde aussi (`settings`) la dernière version des réglages lue dans MyBestConsultant, revalidée avant d'être
utilisée quand il ne répond pas. Une copie par jour est gardée 30 jours dans `historique/`, à côté du fichier ; pendant
un passage, `etat.json.lock` empêche un second passage de démarrer. Modifier le fichier se fait conteneur arrêté
(guide du VPS, partie 6).

- **Renvoyer toutes les offres d'une source** : supprimer sa clé dans `sources`.
- **Accepter une baisse durable** du nombre d'offres (alerte quotidienne alors que la source va bien) : remplacer son
  `lastCount` par le nombre actuel.
- **Ne jamais supprimer le fichier**, ni changer l'`id` d'une source (code ou réglages), ni la supprimer dans les
  réglages pour la recréer sous un autre identifiant (la désactiver plutôt) : toutes ses offres en ligne repartiraient
  vers la boîte AO.
- Un fichier abîmé arrête la veille avec un message explicite plutôt que de tout oublier en silence : le corriger, ou
  reprendre la copie d'un jour précédent dans `historique/` (guide du VPS, partie 6).

## Maintenance

| Besoin | Où |
|---|---|
| Ajouter un organisme, un SIREN ou un nom d'acheteur | admin de MyBestConsultant, « Veille » → Organismes (réglages, voir ci-dessus) |
| Ajouter un code Choisir le service public ou un flux RSS | admin de MyBestConsultant, « Veille » → Sources |
| Code d'un organisme sur Choisir le service public | le nombre dans l'URL `…/nos-offres/filtres/organisme/<code>/` du site |
| Nouveau site sans flux (lecteur propre) | `src/sources/` (une classe par source), `BUILTIN` dans `src/sources/sources.ts` |
| Logique de reconnaissance des acheteurs | `src/tenders/buyer-match.ts`, cas dans `src/tenders/buyer-match.spec.ts` |
| Lecture des réglages, repli | `src/settings/` (format : `veille-settings.ts`, même format que MyBestConsultant) |
| E-mail d'une offre (boîte AO) | `src/digest/offer-email.ts` |
| Avis officiel en PDF joint, lien du dossier de consultation | `src/tenders/notice-pdf.ts` ; adresses : `boampNoticePdfUrl`, `boampDocumentsUrl` (`src/sources/boamp.source.ts`), `tedNoticeToListing` (`src/sources/ted.source.ts`) |
| Date limite d'un appel d'offres (eForms, avis PDF) | `boampEformsDeadline` (`src/sources/boamp.source.ts`), `src/tenders/notice-deadline.ts`, `prepare` (`src/scan.service.ts`) |
| Récapitulatif de l'équipe | `src/digest/digest.ts` |
| Calcul des nouveautés, ordre d'envoi, alertes de volume | `src/state/run-state.ts` |
| Heures des passages planifiés | `MORNING_RUN`, `DAY_RUNS` de `src/run/veille-scheduler.ts` |
| Alerte d'échec d'un passage | `src/digest/alert-email.ts`, `src/run/veille-runner.ts` |
| Serveur, déploiement, secrets de production | [docs/deploiement-vps.md](docs/deploiement-vps.md), `deploy/` |
| Valeurs du périmètre informatique (codes CPV, expressions, sigles) | admin de MyBestConsultant, « Veille » → Filtre informatique |
| Mots-clés des appels d'offres, tous les acheteurs, infrastructure seule | admin de MyBestConsultant, « Veille » → Mots-clés des appels d'offres |
| Recherche chez tous les acheteurs (requêtes BOAMP / TED) | `src/tenders/all-buyers.ts`, `boampAllBuyersWheres`, `tedAllBuyersQueries` |
| Logique du périmètre informatique | `src/it-scope.ts`, cas dans `src/it-scope.spec.ts` |

Quand une source apparaît dans « Points à vérifier » plusieurs jours de suite, ouvrir sa page dans un navigateur,
comparer avec ce qu'attend son fichier dans `src/sources/` (sélecteurs, champs JSON), adapter, puis vérifier avec
`npm run build && npm run veille:essai`.

## Organisation du code

```
src/
  main.ts                 point d'entrée : passages planifiés (--schedule), un passage, ou un essai (--dry-run)
  app.module.ts           assemblage des services
  run/veille-scheduler.ts heures des passages planifiés (5 h, 9 h, 13 h, 17 h UTC), arrêt propre du conteneur
  run/veille-runner.ts    déroulé d'un passage : verrou, passage, boîte AO de MyBestConsultant, alerte en cas d'échec
  run/ao-inbox-sync.ts    lecture de la boîte AO par MyBestConsultant après le passage
  scan.service.ts         un passage : lire, comparer, envoyer chaque offre, enregistrer, récapituler
  settings/               réglages du passage (MyBestConsultant, dernière version connue, config/defaults.json)
  organisations.ts        organismes suivis, tirés des réglages
  it-scope.ts             périmètre informatique (offres envoyées ou écartées)
  phrases.ts              comparaison d'expressions sans accents ni majuscules
  tenders/buyer-match.ts  reconnaissance de l'acheteur d'un avis
  tenders/all-buyers.ts   recherche chez tous les acheteurs (mots-clés, classification)
  tenders/notice-pdf.ts   avis officiel en PDF (BOAMP, TED), téléchargé et joint à l'e-mail de l'offre
  tenders/notice-deadline.ts date limite lue dans le texte de l'avis PDF (dernier recours)
  sources/                une source par fichier (BOAMP, TED, Choisir le service public, sites carrières)
  state/                  calcul des nouveautés (règles pures), fichier d'état, son verrou et son historique
  digest/                 e-mail d'une offre, récapitulatif, mise en forme commune
  mail/                   envoi SMTP (nodemailer, une connexion, une offre par seconde)
  http/                   accès HTTP commun (délai, taille maximale, nouvelle tentative, User-Agent)
  text.ts                 conversion des descriptions HTML en texte
config/defaults.json      réglages du dépôt (premier chargement de MyBestConsultant, tests, dernier recours)
Dockerfile, deploy/       image, conteneur et script de déploiement du VPS (docs/deploiement-vps.md)
```

Choix techniques (NestJS autonome, `tsc`, `node:test`) :
[docs/adr/0002-nest-autonome-etat-sur-branche.md](docs/adr/0002-nest-autonome-etat-sur-branche.md) ; VPS, planificateur
et état sur disque : [docs/adr/0010-vps-planification-nestjs.md](docs/adr/0010-vps-planification-nestjs.md).
