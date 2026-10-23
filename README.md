# Veille marchés et emplois

Chaque matin, les **nouveaux appels d'offres** et les **nouvelles offres d'emploi** de 14 organismes publics et
parapublics partent, **une offre par e-mail** avec son texte complet, vers la boîte AO de MyBestConsultant, qui les
traite comme les autres appels d'offres reçus (lecture par l'IA, offres « à valider », publication par un
administrateur). L'équipe reçoit en plus un récapitulatif quotidien.

Organismes : DGFiP (et son réseau régional et départemental pour les marchés), DINUM, INSEE, ASP, APE, Urssaf Caisse
nationale (ACOSS), CNAM, UCANSS (marchés), La Banque Postale, SFIL, CRH, Cour des comptes, Autorité de la concurrence,
Proparco, Expertise France.

- Appels d'offres : BOAMP et TED (Journal officiel de l'UE), par leurs API officielles.
- Offres d'emploi : Choisir le service public (flux RSS) et les sites carrières des organismes.
- Détail des sources, de leurs conditions d'usage et des sources écartées (PLACE, offres Urssaf / CNAM) :
  [docs/adr/0001-sources-et-contraintes.md](docs/adr/0001-sources-et-contraintes.md).
- Pourquoi une offre par e-mail, et ce qu'il faut vérifier avant de publier :
  [docs/adr/0003-une-offre-par-e-mail-vers-la-boite-ao.md](docs/adr/0003-une-offre-par-e-mail-vers-la-boite-ao.md).

## Fonctionnement

1. Le workflow GitHub `Veille quotidienne` démarre tous les jours à 5 h UTC.
2. Chaque source est lue l'une après l'autre (5 minutes environ). Une source en panne n'empêche pas les autres.
3. Une annonce est **nouvelle** si son identifiant n'a jamais été envoyé depuis sa source (fichier `etat.json`, sur
   la branche Git `veille-etat`, voir « État de la veille »). Les sources d'offres d'emploi donnent toutes leurs offres
   en ligne ; pour les appels d'offres, ce sont **tous les avis encore ouverts** (date limite de réponse non passée,
   publiés depuis 120 jours) : le premier passage envoie tout ce à quoi on peut encore répondre, et un passage manqué
   est rattrapé tant que l'avis est ouvert.
4. Chaque nouvelle offre part dans **son propre e-mail** vers la boîte AO (`OFFERS_TO`) : intitulé, client
   (l'organisme), lieu, précisions, dates, référence, lien, puis le texte complet. Quand la liste de la source ne
   donne pas tout, la page de l'offre est lue au moment de l'envoyer (Choisir le service public : employeur exact et
   date limite ; Expertise France et La Banque Postale : texte de l'offre).
5. Au plus `MAX_OFFER_EMAILS_PER_RUN` offres par passage (200 par défaut), une par seconde, et aucune nouvelle offre
   commencée après 25 minutes de passage ; appels d'offres d'abord. Les autres attendent le passage suivant. **Le premier passage** trouve toutes les offres en ligne (environ 750) :
   elles partent sur plusieurs jours, ou plus vite en relançant le workflow à la main.
6. Une offre dont la date limite est déjà passée (souvent connue par la page de l'offre) n'est pas envoyée ; elle est
   retenue comme traitée et comptée dans le récapitulatif.
7. Une offre n'est retenue comme envoyée qu'une fois son e-mail accepté par le serveur : si le serveur refuse
   (quota, adresse), l'envoi s'arrête et le reste part au passage suivant ; s'il refuse un seul message (contenu),
   celui-ci est sauté, signalé, et retenté au passage suivant.
8. Un **récapitulatif** part ensuite vers l'équipe (`MAIL_TO`), **même sans nouveauté** (son arrivée prouve que la
   veille tourne) : offres envoyées, offres en attente, points à vérifier.

Le récapitulatif signale en tête les **points à vérifier** :

- envoi des offres interrompu (serveur SMTP) ;
- lecture impossible : site en panne, page ou API dont le format a changé, lien d'offre vers un site inattendu ;
- nombre d'offres d'emploi qui s'effondre (vidé, ou divisé par plus de deux) : l'alerte revient **chaque jour**
  jusqu'à ce que la source retrouve son volume ; pendant ce temps, rien n'est oublié de ce qu'elle avait montré ;
- aucun appel d'offres depuis trois semaines (requête BOAMP / TED devenue invalide) ;
- avis BOAMP au contenu illisible, offres envoyées sans le détail de leur page, offres AFD dont l'examen est reporté.

Un appel d'offres publié à la fois au BOAMP et à TED n'est envoyé qu'une fois.

Dans MyBestConsultant, chaque e-mail d'offre porte l'en-tête `X-Wise-Veille: scraping` : la page AO affiche alors
« Scraping » dans la colonne « Source » (au lieu de « E-mails AO »), écarte une offre échue, et dédoublonne avec les
offres reçues par ailleurs (même intitulé, client, ville et contrat sur 60 jours). L'en-tête n'est reconnu que si
l'expéditeur est d'un domaine de l'organisation (voir l'ADR 0008 de MyBestConsultant).

## Prérequis

- Node.js 22.12 ou plus (24 recommandé, voir `.nvmrc`) et npm.
- Pour la production : un dépôt GitHub (privé) et une boîte e-mail avec accès SMTP, d'un domaine de l'organisation.

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

## Configuration

Variables d'environnement, toutes décrites dans [.env.example](.env.example) : `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASSWORD`, `MAIL_FROM`, `OFFERS_TO` (boîte AO), `MAIL_TO` (équipe, adresses séparées par des virgules),
`MAX_OFFER_EMAILS_PER_RUN` et `STATE_FILE` (facultatifs). Une variable manquante ou invalide arrête le passage avant
toute lecture (le message nomme la variable, jamais sa valeur).

- L'adresse de `MAIL_FROM` doit être celle de la boîte `SMTP_USER`, ou un alias autorisé de cette boîte : la plupart
  des serveurs refusent sinon l'envoi (« 550 Sender address is not allowed »).
- Elle doit aussi être d'un domaine de l'organisation (`@wise-associates.fr`) : MyBestConsultant prend sinon
  l'expéditeur pour le client de toutes les offres, au lieu de l'organisme nommé dans l'e-mail.
- Les serveurs d'envoi limitent les volumes. La veille ouvre une nouvelle connexion tous les 10 messages (IONOS en
  refuse plus de 20 par connexion) et n'envoie qu'un message par seconde. Si le serveur limite aussi par heure ou par
  jour (« Refus temporaire du serveur SMTP » dans le récapitulatif), baisser `MAX_OFFER_EMAILS_PER_RUN` : les offres
  non envoyées partent simplement au passage suivant.

## Mise en production (GitHub Actions)

1. Pousser ce dépôt sur GitHub (dépôt privé de l'organisation).
2. Dans **Settings → Secrets and variables → Actions**, créer les secrets `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
   `SMTP_PASSWORD`, `MAIL_FROM`, `OFFERS_TO`, `MAIL_TO` ; facultatif, la variable (onglet « Variables »)
   `MAX_OFFER_EMAILS_PER_RUN`.
3. Laisser les permissions par défaut des workflows en lecture seule (**Settings → Actions → General**) : chaque job
   déclare lui-même ce dont il a besoin. Ne pas protéger la branche `veille-etat` contre `github-actions[bot]`.
4. Onglet **Actions → Veille quotidienne → Run workflow** : d'abord avec « Essai » coché (récapitulatif et premier
   e-mail d'offre dans le journal), puis sans. Le premier vrai passage crée la branche `veille-etat` et envoie les
   200 premières offres ; relancer le workflow pour envoyer les suivantes plus tôt.
5. Recommandé : protéger la branche `main` (pull request obligatoire) dans **Settings → Rules**.

Le workflow a trois jobs : `passage` exécute la veille avec un jeton **en lecture seule** ; `enregistrer`, qui
n'exécute que git, pousse l'état sur `veille-etat` ; `alerte` ouvre (ou complète) le ticket « Échec de la veille
quotidienne » si un passage échoue : toutes les personnes qui suivent le dépôt sont prévenues, et le ticket renvoie au
journal de l'exécution. Le fermer une fois corrigé.

Codes de sortie du programme : 0, passage complet ; 1, passage interrompu avant l'enregistrement de l'état ; 3, état
enregistré mais un envoi a échoué (offres ou récapitulatif). Avec le code 3, le workflow pousse quand même l'état,
pour que les offres déjà envoyées ne repartent pas, puis ouvre le ticket.

Le workflow `Vérifications` lance types, tests, compilation et `npm audit` à chaque poussée.

## État de la veille

`etat.json` (branche `veille-etat`) retient, pour chaque source, les identifiants déjà envoyés (ou écartés) et la
date à laquelle leur présence a été notée (rafraîchie au plus une fois par mois), le nombre d'annonces de référence,
ainsi que les procédures d'appel d'offres déjà envoyées. Une annonce absente de sa source depuis 90 à 120 jours est
oubliée. Chaque passage ajoute un commit : l'historique montre l'état de n'importe quel jour.

- **Renvoyer toutes les offres d'une source** : supprimer sa clé dans `sources` (commit sur `veille-etat`).
- **Accepter une baisse durable** du nombre d'offres (alerte quotidienne alors que la source va bien) : remplacer son
  `lastCount` par le nombre actuel.
- **Ne jamais supprimer la branche** ni renommer l'`id` d'une source dans le code : toutes ses offres en ligne
  repartiraient vers la boîte AO.
- Un fichier abîmé arrête la veille avec un message explicite plutôt que de tout oublier en silence : le corriger, ou
  revenir au commit précédent de la branche.

## Maintenance

| Besoin | Où |
|---|---|
| Ajouter un organisme ou un nom d'acheteur | `src/organisations.ts` (règles commentées), test dans `src/tenders/buyer-match.spec.ts` |
| Ajouter / modifier une source d'offres d'emploi | `src/sources/` (une classe par source), liste dans `src/sources/sources.ts` |
| Code d'un organisme sur Choisir le service public | le nombre dans l'URL `…/nos-offres/filtres/organisme/<code>/` du site |
| E-mail d'une offre (boîte AO) | `src/digest/offer-email.ts` |
| Récapitulatif de l'équipe | `src/digest/digest.ts` |
| Calcul des nouveautés, ordre d'envoi, alertes de volume | `src/state/run-state.ts` |

Quand une source apparaît dans « Points à vérifier » plusieurs jours de suite, ouvrir sa page dans un navigateur,
comparer avec ce qu'attend son fichier dans `src/sources/` (sélecteurs, champs JSON), adapter, puis vérifier avec
`npm run build && npm run veille:essai`.

## Organisation du code

```
src/
  main.ts                 point d'entrée (contexte Nest autonome, codes de sortie)
  app.module.ts           assemblage des services
  scan.service.ts         un passage : lire, comparer, envoyer chaque offre, enregistrer, récapituler
  organisations.ts        organismes suivis et règles de reconnaissance des acheteurs
  tenders/buyer-match.ts  reconnaissance de l'acheteur d'un avis
  sources/                une source par fichier (BOAMP, TED, Choisir le service public, sites carrières)
  state/                  calcul des nouveautés (règles pures) et fichier d'état
  digest/                 e-mail d'une offre, récapitulatif, mise en forme commune
  mail/                   envoi SMTP (nodemailer, une connexion, une offre par seconde)
  http/                   accès HTTP commun (délai, taille maximale, nouvelle tentative, User-Agent)
  text.ts                 conversion des descriptions HTML en texte
```

Choix techniques (NestJS autonome, `tsc`, `node:test`, état sur branche) :
[docs/adr/0002-nest-autonome-etat-sur-branche.md](docs/adr/0002-nest-autonome-etat-sur-branche.md).
