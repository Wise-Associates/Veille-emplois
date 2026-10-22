# Veille marchés et emplois

Chaque matin, un e-mail récapitule les **nouveaux appels d'offres** et les **nouvelles offres d'emploi** de 14
organismes publics et parapublics : DGFiP (et son réseau régional et départemental pour les marchés), DINUM, INSEE,
ASP, APE, Urssaf Caisse nationale (ACOSS), CNAM, UCANSS (marchés), La Banque Postale, SFIL, CRH, Cour des comptes,
Autorité de la concurrence, Proparco, Expertise France.

- Appels d'offres : BOAMP et TED (Journal officiel de l'UE), par leurs API officielles.
- Offres d'emploi : Choisir le service public (flux RSS) et les sites carrières des organismes.
- Détail des sources, de leurs conditions d'usage et des sources écartées (PLACE, offres Urssaf / CNAM) :
  [docs/adr/0001-sources-et-contraintes.md](docs/adr/0001-sources-et-contraintes.md).

## Fonctionnement

1. Le workflow GitHub `Veille quotidienne` démarre tous les jours à 5 h UTC.
2. Chaque source est lue l'une après l'autre (5 minutes environ). Une source en panne n'empêche pas les autres.
3. Une annonce est **nouvelle** si son identifiant n'a jamais été vu dans sa source. Les annonces vues sont retenues
   dans `etat.json`, sur la branche Git `veille-etat` (voir « État de la veille »).
4. Le récapitulatif est envoyé par e-mail (SMTP), **même sans nouveauté** : son arrivée prouve que la veille tourne.
5. L'état n'est enregistré qu'après l'envoi : si l'e-mail ne part pas, les nouveautés seront annoncées le lendemain.

Le récapitulatif signale en tête les **sources à vérifier** :

- lecture impossible : site en panne, page ou API dont le format a changé, lien d'offre vers un site inattendu ;
- nombre d'offres d'emploi qui s'effondre (vidé, ou divisé par plus de deux) : l'alerte revient **chaque jour**
  jusqu'à ce que la source retrouve son volume ; pendant ce temps, rien n'est oublié de ce qu'elle avait montré ;
- aucun appel d'offres depuis trois semaines (requête BOAMP / TED devenue invalide) ;
- avis BOAMP au contenu illisible, offres AFD dont l'examen est reporté.

Lorsqu'une source est lue pour la première fois, ses annonces en ligne sont enregistrées sans être annoncées ; ses
nouveautés le sont à partir du passage suivant.

Un appel d'offres publié à la fois au BOAMP et à TED n'est annoncé qu'une fois.

## Prérequis

- Node.js 22.12 ou plus (24 recommandé, voir `.nvmrc`) et npm.
- Pour la production : un dépôt GitHub (privé) et une boîte e-mail avec accès SMTP.

## Installation et commandes

```bash
npm ci                  # dépendances (versions figées par package-lock.json)
npm run build           # compile dans dist/
npm run veille:essai    # lit toutes les sources et affiche le récapitulatif ; n'envoie rien, n'enregistre rien
npm run veille:local    # passage complet avec la configuration de .env (copier .env.example)
npm run typecheck       # vérification des types
npm test                # tests (node:test, sur le code compilé dans dist-test/)
```

`npm run veille:essai` utilise `etat/etat.json` s'il existe (sinon toutes les sources apparaissent « lues pour la
première fois »). Pour voir des annonces dans un essai, pointez `STATE_FILE` vers une copie de l'état de production.

## Configuration

Variables d'environnement, toutes décrites dans [.env.example](.env.example) : `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASSWORD`, `MAIL_FROM`, `MAIL_TO` (destinataires séparés par des virgules), `STATE_FILE` (facultatif). Une
variable manquante ou invalide arrête le passage avant toute lecture (le message nomme la variable, jamais sa valeur).

L'adresse de `MAIL_FROM` doit être celle de la boîte `SMTP_USER`, ou un alias autorisé de cette boîte : la plupart
des serveurs refusent sinon l'envoi (« 550 Sender address is not allowed »). Le passage s'arrête alors sans rien
enregistrer, et les nouveautés seront envoyées au passage suivant.

## Mise en production (GitHub Actions)

1. Pousser ce dépôt sur GitHub (dépôt privé de l'organisation).
2. Dans **Settings → Secrets and variables → Actions**, créer les secrets `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
   `SMTP_PASSWORD`, `MAIL_FROM`, `MAIL_TO`.
3. Laisser les permissions par défaut des workflows en lecture seule (**Settings → Actions → General**) : chaque job
   déclare lui-même ce dont il a besoin. Ne pas protéger la branche `veille-etat` contre `github-actions[bot]`.
4. Onglet **Actions → Veille quotidienne → Run workflow** : d'abord avec « Essai » coché (lecture et récapitulatif
   dans le journal), puis sans. Ce premier vrai passage crée la branche `veille-etat` et envoie un e-mail
   « aucune nouveauté » qui liste les sources initialisées. Les nouveautés arrivent dès le lendemain.
5. Recommandé : protéger la branche `main` (pull request obligatoire) dans **Settings → Rules**.

Le workflow a trois jobs : `passage` exécute la veille avec un jeton **en lecture seule** ; `enregistrer`, qui
n'exécute que git, pousse l'état sur `veille-etat` ; `alerte` ouvre (ou complète) le ticket « Échec de la veille
quotidienne » si un passage échoue (configuration, fichier d'état, envoi de l'e-mail, poussée) : toutes les personnes
qui suivent le dépôt sont prévenues, et le ticket renvoie au journal de l'exécution. Le fermer une fois corrigé.
Le workflow `Vérifications` lance types, tests, compilation et `npm audit` à chaque poussée.

## État de la veille

`etat.json` (branche `veille-etat`) retient, pour chaque source, les identifiants déjà vus et la date à laquelle leur
présence a été notée (rafraîchie au plus une fois par mois), le nombre d'annonces de référence, ainsi que les
procédures d'appel d'offres déjà annoncées. Une annonce absente de sa source depuis 90 à 120 jours est oubliée.
Chaque passage ajoute un commit : l'historique montre l'état de n'importe quel jour.

- **Repartir de zéro pour une source** : supprimer sa clé dans `sources` (commit sur `veille-etat`) ; elle sera
  réinitialisée au passage suivant.
- **Accepter une baisse durable** du nombre d'offres (alerte quotidienne alors que la source va bien) : remplacer son
  `lastCount` par le nombre actuel.
- **Ne jamais supprimer la branche** ni renommer l'`id` d'une source dans le code : la source repartirait de zéro.
- Un fichier abîmé arrête la veille avec un message explicite plutôt que de tout oublier en silence : le corriger, ou
  revenir au commit précédent de la branche.

## Maintenance

| Besoin | Où |
|---|---|
| Ajouter un organisme ou un nom d'acheteur | `src/organisations.ts` (règles commentées), test dans `src/tenders/buyer-match.spec.ts` |
| Ajouter / modifier une source d'offres d'emploi | `src/sources/` (une classe par source), liste dans `src/sources/sources.ts` |
| Code d'un organisme sur Choisir le service public | le nombre dans l'URL `…/nos-offres/filtres/organisme/<code>/` du site |
| Présentation de l'e-mail | `src/digest/digest.ts` |
| Calcul des nouveautés et alertes de volume | `src/state/run-state.ts` |

Quand une source apparaît dans « Sources à vérifier » plusieurs jours de suite, ouvrir sa page dans un navigateur,
comparer avec ce qu'attend son fichier dans `src/sources/` (sélecteurs, champs JSON), adapter, puis vérifier avec
`npm run build && npm run veille:essai`.

## Organisation du code

```
src/
  main.ts                 point d'entrée (contexte Nest autonome, code de sortie)
  app.module.ts           assemblage des services
  scan.service.ts         un passage : lire, comparer, envoyer, enregistrer
  organisations.ts        organismes suivis et règles de reconnaissance des acheteurs
  tenders/buyer-match.ts  reconnaissance de l'acheteur d'un avis
  sources/                une source par fichier (BOAMP, TED, Choisir le service public, sites carrières)
  state/                  calcul des nouveautés (règles pures) et fichier d'état
  digest/                 récapitulatif texte et HTML
  mail/                   envoi SMTP (nodemailer)
  http/                   accès HTTP commun (délai, nouvelle tentative, User-Agent)
```

Choix techniques (NestJS autonome, `tsc`, `node:test`, état sur branche) :
[docs/adr/0002-nest-autonome-etat-sur-branche.md](docs/adr/0002-nest-autonome-etat-sur-branche.md).
