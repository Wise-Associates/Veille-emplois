# La veille sur le VPS

Guide d'installation et d'exploitation de la veille sur le serveur de MyBestConsultant (Hetzner, Ubuntu 24.04), de
la préparation à la vie courante. Décision et raisons : [ADR 0010](adr/0010-vps-planification-nestjs.md).

Ce guide s'adresse à la personne qui administre le serveur. Les commandes sont à lancer telles quelles ; les valeurs
entre `<…>` sont à remplacer. Comptez une heure pour l'installation, puis une demi-heure pour la bascule depuis
GitHub Actions.

## Sommaire

1. [Vue d'ensemble](#1-vue-densemble)
2. [Préparer le serveur](#2-préparer-le-serveur-une-fois)
3. [Configurer GitHub](#3-configurer-github-une-fois)
4. [Bascule depuis GitHub Actions](#4-bascule-depuis-github-actions-une-fois)
5. [Au quotidien](#5-au-quotidien)
6. [Exploitation](#6-exploitation)
7. [Dépannage](#7-dépannage)

## 1. Vue d'ensemble

```
Serveur de MyBestConsultant (Hetzner)
└── conteneur « veille », toujours lancé, sans port ouvert
      ├── 5 h, 9 h, 13 h et 17 h UTC : un passage (planificateur NestJS, src/run/veille-scheduler.ts)
      │     ├─► BOAMP, TED, sites carrières (lecture)
      │     ├─► MyBestConsultant : réglages au début, lecture de la boîte AO à la fin
      │     └─► serveur SMTP (port 587) : une offre par e-mail vers la boîte AO, récapitulatif, alerte d'échec
      └── /data  ◄──  /opt/veille-marches-emplois/donnees (état, verrou, historique de 30 jours)
```

- **Un seul conteneur**, à côté de ceux de MyBestConsultant (`mbc-*`), sans rien partager avec eux : ni réseau, ni
  fichier, ni secret. Il redémarre tout seul après une panne ou un redémarrage du serveur.
- **Les heures sont dans le code** (`src/run/veille-scheduler.ts`), en UTC, comme avec l'ancien workflow GitHub : le
  passage de 5 h envoie toujours le récapitulatif à l'équipe (son arrivée prouve que la veille tourne), les autres
  seulement s'il y a un point à vérifier.
- **L'état est un fichier du serveur** (annonces déjà envoyées) : une copie par jour est gardée 30 jours.
- **Un passage en échec prévient l'équipe par e-mail** (`MAIL_TO`), à la place du ticket GitHub.
- **Mise en service à la main** : GitHub → Actions → « Déployer sur le VPS », depuis `main`. GitHub vérifie le code
  (types, tests), construit l'image Docker et l'envoie au serveur par SSH. Rien n'est construit sur le serveur.

| Dans le dépôt | Rôle |
|---|---|
| `Dockerfile`, `.dockerignore` | Image de la veille (Node 24, la même image de base que MyBestConsultant) |
| `deploy/compose.yml` | Le conteneur, durci : lecture seule, sans privilège, sans port publié |
| `deploy/veille-deploy.sh` | Déploiement, retour arrière, relance, état |
| `.github/workflows/deploy-vps.yml` | « Déployer sur le VPS », lancé à la main : vérification, image, envoi |

| Sur le serveur | Contenu |
|---|---|
| `/etc/veille-marches-emplois/veille.env` | Secrets et réglages (root, lisible par `deploy`) |
| `/opt/veille-marches-emplois/donnees` | `etat.json`, son verrou pendant un passage, `historique/` |
| `/opt/veille-marches-emplois/repo` | Copie du dépôt (lecture seule), placée sur le commit déployé |
| `/opt/veille-marches-emplois/deploiement` | Commit en ligne, journal du dernier déploiement |
| `/usr/local/bin/veille-deploy` | Copie installée de `deploy/veille-deploy.sh` |

## 2. Préparer le serveur (une fois)

Le serveur est celui de MyBestConsultant, déjà préparé par son guide (`docs/deploiement-vps.md` de MyBestConsultant,
parties 3.1 à 3.5) : compte d'administration, SSH sans mot de passe, serveur en UTC, pare-feu, Docker, utilisateur
`deploy` dans le groupe `docker`. Vérifiez :

```bash
docker compose version        # v2.24 ou plus récent
id deploy                     # le groupe « docker » doit apparaître
python3 --version             # présent d'office sur Ubuntu 24.04 : veille-deploy s'en sert pour ses vérifications
timedatectl | grep 'Time zone' # UTC (les heures des passages sont en UTC de toute façon)
getent passwd 10001           # aucune ligne attendue : l'utilisateur du conteneur n'a pas de compte sur le serveur
```

Toutes les commandes de cette partie se lancent sur le serveur, avec votre compte d'administration.

### 2.1 Dossiers

```bash
sudo install -d -o deploy -g deploy -m 750 /opt/veille-marches-emplois
sudo install -d -o deploy -g deploy -m 750 /opt/veille-marches-emplois/deploiement
# Écrit par le conteneur (uid 10001, sans compte sur le serveur) ; lisible par deploy, qui y vérifie le verrou d'un
# passage avant un déploiement. 2750 : les fichiers créés gardent le groupe deploy.
sudo install -d -o 10001 -g deploy -m 2750 /opt/veille-marches-emplois/donnees
sudo install -d -o root -g deploy -m 750 /etc/veille-marches-emplois
```

### 2.2 Copie du dépôt

Le serveur lit le dépôt de la veille avec **sa propre clé**, en lecture seule : GitHub n'accepte une clé de
déploiement que sur un seul dépôt, et celle de MyBestConsultant (`github_repo`) est déjà prise.

```bash
sudo -u deploy ssh-keygen -t ed25519 -N "" -C "vps veille (lecture du depot)" -f /home/deploy/.ssh/github_veille
sudo -u deploy tee -a /home/deploy/.ssh/config > /dev/null <<'EOF'

# Dépôt de la veille : sa propre clé de déploiement (GitHub n'en accepte qu'une par dépôt).
Host github-veille
  HostName github.com
  User git
  IdentityFile ~/.ssh/github_veille
  IdentitiesOnly yes
EOF
sudo cat /home/deploy/.ssh/github_veille.pub
```

Sur GitHub : dépôt `Wise-Associates/Veille-emplois` → Settings → Deploy keys → Add deploy key, collez la clé
publique, **sans** cocher « Allow write access ». Puis :

```bash
sudo -u deploy ssh -T github-veille
# Réponse attendue : « Hi Wise-Associates/Veille-emplois! You've successfully authenticated »
sudo -u deploy git clone github-veille:Wise-Associates/Veille-emplois.git /opt/veille-marches-emplois/repo
```

Le dossier `deploy/` doit exister sur `main` (ce guide y arrive avec lui). Ne modifiez jamais de fichier dans cette
copie : chaque déploiement la place sur le commit déployé, et une modification locale le ferait échouer.

### 2.3 Script de déploiement

```bash
sudo install -m 755 /opt/veille-marches-emplois/repo/deploy/veille-deploy.sh /usr/local/bin/veille-deploy
sudo -u deploy veille-deploy status        # attendu : « aucune version déployée »
```

### 2.4 Secrets : `veille.env`

```bash
sudo install -o root -g deploy -m 640 /dev/null /etc/veille-marches-emplois/veille.env
sudoedit /etc/veille-marches-emplois/veille.env
```

Contenu : les **secrets du dépôt sur GitHub** (Settings → Secrets and variables → Actions), avec les mêmes valeurs.
GitHub ne les laisse pas relire : reprenez-les à leur source (gestionnaire de mots de passe de l'équipe, messagerie).
Leur rôle est décrit dans `.env.example`.

```
SMTP_HOST='<serveur SMTP, ex. smtp.ionos.fr>'
SMTP_PORT='587'
SMTP_USER='<veille@wise-associates.fr>'
SMTP_PASSWORD='<mot de passe de cette boîte>'
MAIL_FROM='Veille marchés et emplois <veille@wise-associates.fr>'
OFFERS_TO='<boîte AO de MyBestConsultant>'
MAIL_TO='<adresses de l équipe, séparées par des virgules>'
VEILLE_CONFIG_URL='https://www.mybestconsultant.fr/api/veille/config'
VEILLE_CONFIG_TOKEN='<VEILLE_CONFIG_TOKEN de MyBestConsultant>'
AO_SYNC_URL='https://www.mybestconsultant.fr/api/cron/ao-inbox'
AO_SYNC_TOKEN='<CRON_SECRET de /etc/mybestconsultant/app.env>'
MAX_OFFER_EMAILS_PER_RUN='200'
```

Points à vérifier :

- **Format** : une variable par ligne, chaque valeur entre apostrophes, sans `export`. Sans apostrophes, Docker
  modifie la valeur sans rien dire (tout ce qui suit un `$` disparaît). Une valeur qui contient une apostrophe ne
  passe pas : régénérez ce secret.
- **`SMTP_PORT='587'`** (STARTTLS) : Hetzner bloque par défaut les ports sortants 25 et 465 de ses serveurs (lutte
  contre le spam). Avec 465, chaque envoi échouerait par délai dépassé.
- **`AO_SYNC_TOKEN`** : la même valeur que `CRON_SECRET` de MyBestConsultant, sur ce même serveur. Quand elle change
  là-bas, changez-la ici (et relancez, 5).
- Ne mettez ni `STATE_FILE` (fixé par `deploy/compose.yml`) ni `DIGEST_MODE` (le planificateur le choisit).
- Ne copiez pas ce fichier ailleurs que sur le serveur et dans le gestionnaire de mots de passe de l'équipe.

### 2.5 Clé SSH de GitHub Actions

Sur **votre poste** (pas sur le serveur), dans un dossier temporaire :

```bash
ssh-keygen -t ed25519 -N "" -C "github-actions deploiement veille" -f veille-deploy-key
cat veille-deploy-key.pub
```

Sur le serveur, **ajoutez** cette clé à celles de `deploy`, limitée à la seule commande `veille-deploy` (une ligne,
clé publique collée après le dernier espace). Attention : `tee -a` (ajout). Un `tee` sans `-a` effacerait la clé de
déploiement de MyBestConsultant.

```bash
sudo -u deploy tee -a /home/deploy/.ssh/authorized_keys > /dev/null <<'EOF'
restrict,command="/usr/local/bin/veille-deploy" ssh-ed25519 AAAA...collez-la-cle... github-actions deploiement veille
EOF
sudo cat /home/deploy/.ssh/authorized_keys     # deux lignes : mbc-deploy et veille-deploy
```

Depuis votre poste : `ssh -i veille-deploy-key deploy@<ip> status` affiche « aucune version déployée », et
`ssh -i veille-deploy-key deploy@<ip> ls` est refusé (usage). La clé privée ira dans GitHub (3) : effacez ensuite les
deux fichiers de votre poste. Perdue ou exposée : générez-en une autre et remplacez sa ligne et le secret.

**Cette clé vaut un accès aux secrets de la veille.** Elle ne lance que `veille-deploy`, mais elle peut lui envoyer
n'importe quelle image, qui démarrerait avec les secrets de `veille.env` : le serveur ne peut pas vérifier qu'une image
vient bien du workflow. `veille-deploy` limite le reste : une seule image par envoi (jamais celles de
MyBestConsultant), et un conteneur sans privilège, sans port, avec le seul dossier d'état. Elle n'est donc donnée
qu'au job de déploiement, lancé depuis `main` (3), et ne doit exister nulle part ailleurs.

## 3. Configurer GitHub (une fois)

Dépôt `Wise-Associates/Veille-emplois` → Settings. Le serveur est celui de MyBestConsultant : **les deux protections
du point 1 sont obligatoires**. Sans elles, toute personne (ou tout jeton, tout outil) qui peut écrire dans `main`
peut mettre en service seule le code de son choix, avec les secrets de la veille.

1. **Protections** :
   - **Rules → Rulesets → New branch ruleset**, cible `main`, sans contournement : **Require a pull request before
     merging** (au moins une approbation), **Block force pushes**, **Restrict deletions**.
   - Dans l'environnement `production` (point 2) : **Required reviewers** avec **Prevent self-review** : une seconde
     personne valide chaque déploiement dans l'onglet Actions.
2. **Environments → New environment** `production`. « Deployment branches and tags » : « Selected branches and tags »,
   règle `main`. Secrets de l'environnement :
   - `VPS_SSH_KEY` : le contenu de `veille-deploy-key` (clé privée, lignes `-----BEGIN…` et `-----END…` comprises) ;
   - `VPS_SSH_KNOWN_HOSTS` : l'empreinte du serveur, la même que pour MyBestConsultant. Depuis votre poste :
     `ssh-keyscan -t ed25519 <ip> 2>/dev/null`, à comparer avec `sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`
     lancé sur le serveur (`ssh-keygen -lf` sur la ligne relevée donne la même empreinte).
3. **Secrets and variables → Actions → Variables** : `VPS_HOST` = l'adresse IP du serveur (celle de l'empreinte).
4. **Actions → General** : laissez les permissions par défaut des workflows en lecture seule.

## 4. Bascule depuis GitHub Actions (une fois)

L'ordre compte : **jamais deux veilles en même temps** (chaque offre partirait deux fois), et **jamais sans l'état**
(toutes les offres en ligne repartiraient, environ 450).

1. Faites entrer ce changement dans `main` (pull request), puis faites les parties 2 et 3.
2. Choisissez un moment entre deux passages : ils partent à 5 h, 9 h, 13 h et 17 h UTC et durent moins d'une heure
   (par exemple entre 10 h 30 et 12 h 30 UTC).
3. **Arrêtez l'ancienne veille** : GitHub → Actions → « Veille quotidienne ». Vérifiez qu'aucune exécution n'est en
   cours, puis « … » → **Disable workflow**.
4. **Copiez l'état** de la branche `veille-etat` sur le serveur :

   ```bash
   sudo -u deploy git -C /opt/veille-marches-emplois/repo fetch --quiet origin veille-etat
   sudo -u deploy git -C /opt/veille-marches-emplois/repo show origin/veille-etat:etat.json > /tmp/etat.json
   python3 -c "import json; print(len(json.load(open('/tmp/etat.json'))['sources']), 'sources dans l état')"
   sudo install -o 10001 -g deploy -m 640 /tmp/etat.json /opt/veille-marches-emplois/donnees/etat.json
   rm /tmp/etat.json
   ```

   Le nombre affiché doit être celui des sources de la veille (17 le 05/11/2026). Une erreur ici : ne continuez pas.
5. **Déployez** : GitHub → Actions → « Déployer sur le VPS » → Run workflow, branche `main`. Attendu : les deux jobs
   au vert. Sur le serveur :

   ```bash
   sudo -u deploy veille-deploy status          # en ligne : commit …, conteneur « healthy »
   sudo -u deploy docker logs veille            # « Veille planifiée : … Prochains : … »
   ```

6. **Essai** dans le conteneur (rien n'est envoyé ni enregistré) :

   ```bash
   sudo -u deploy docker exec veille node dist/main.js --dry-run
   ```

   Il lit les sources, puis affiche le récapitulatif et le premier e-mail d'offre. Les offres annoncées comme
   nouvelles (« N nouvelle(s) annonce(s) » dans le journal) sont celles que l'ancienne veille n'avait pas encore
   envoyées : à peu près le nombre « en attente » de son dernier récapitulatif, plus les nouveautés du jour. Si elles
   se comptent par centaines alors que ce récapitulatif n'en annonçait pas, l'état n'a pas été repris : arrêtez
   (`sudo -u deploy docker stop veille`) et refaites l'étape 4.
7. Au passage suivant, vérifiez le journal (`sudo -u deploy docker logs --since 1h veille`) et l'arrivée des offres
   dans la page AO de MyBestConsultant. Le lendemain, le récapitulatif de 5 h UTC doit arriver.
8. **Une semaine plus tard**, si tout va bien : retirez `.github/workflows/veille-quotidienne.yml` par une pull
   request, et supprimez les secrets du dépôt que plus rien n'utilise (`SMTP_*`, `MAIL_*`, `OFFERS_TO`,
   `VEILLE_CONFIG_*`, `AO_SYNC_*`) et la variable `MAX_OFFER_EMAILS_PER_RUN`. La branche `veille-etat` peut rester comme
   archive, mais **ne réactivez jamais l'ancien workflow** : il repartirait de cet état ancien et renverrait des
   offres.

## 5. Au quotidien

| Besoin | Commande ou action |
|---|---|
| Mettre en service une nouvelle version | Fusion dans `main`, puis GitHub → Actions → « Déployer sur le VPS ». Refusé pendant un passage : relancez une demi-heure plus tard. |
| Envoyer tout de suite les offres en attente | `sudo -u deploy docker exec veille node dist/main.js` (passage complet ; refusé si un autre passage est en cours) |
| Essai (rien n'est envoyé ni enregistré) | `sudo -u deploy docker exec veille node dist/main.js --dry-run` |
| Journal | `sudo -u deploy docker logs --since 12h veille` (`-f` pour suivre) |
| Version en ligne, images gardées | `sudo -u deploy veille-deploy status` |
| Après une modification de `veille.env` | `sudo -u deploy veille-deploy restart` |
| Remettre l'état d'un jour (historique de 30 jours) | `sudo -u deploy veille-deploy restore <AAAA-MM-JJ>` (6) |
| Retour arrière | `sudo -u deploy veille-deploy rollback <commit complet>` (images des 5 dernières versions) |
| Changer les heures des passages | `MORNING_RUN` et `DAY_RUNS` de `src/run/veille-scheduler.ts` (et le README), puis déploiement |

**Mettre à jour `veille-deploy`** : quand `deploy/veille-deploy.sh` change, le journal du déploiement le signale
(« diffère de la copie installée »). La copie du dépôt est alors sur le commit déployé :

```bash
sudo install -m 755 /opt/veille-marches-emplois/repo/deploy/veille-deploy.sh /usr/local/bin/veille-deploy
```

## 6. Exploitation

### État de la veille

- `/opt/veille-marches-emplois/donnees/etat.json` : annonces déjà envoyées (format et règles : README, « État de la
  veille »). `etat.json.lock` n'existe que pendant un passage.
- `historique/etat-AAAA-MM-JJ.json` : l'état à la fin de chaque jour (heure de Paris), 30 jours.
- **Revenir à l'état d'un jour** (après un passage qui l'aurait abîmé) :

  ```bash
  sudo -u deploy veille-deploy restore <AAAA-MM-JJ>
  ```

  Le script arrête la veille (un passage en cours va au bout), remet la copie de ce jour, puis relance la veille. La
  copie est faite dans un conteneur, sous l'utilisateur de la veille : **ne copiez jamais un fichier de ce dossier avec
  `sudo cp` ou `sudo install`**. Le conteneur écrit dans ce dossier ; un lien symbolique qu'il y aurait posé ferait
  copier par root un fichier du serveur (les secrets de MyBestConsultant, par exemple) à un endroit qu'il peut lire.
- **Modifier l'état à la main** (renvoyer les offres d'une source, accepter une baisse durable : README), conteneur
  arrêté, avec `sudoedit` (qui refuse d'ouvrir un lien symbolique) :

  ```bash
  sudo -u deploy docker stop veille
  sudoedit /opt/veille-marches-emplois/donnees/etat.json
  sudo -u deploy docker start veille
  ```

### Sauvegardes

L'état est la seule donnée de la veille : perdu, toutes les offres en ligne repartiraient vers la boîte AO
(MyBestConsultant écarte les doublons des 60 derniers jours). L'historique est sur le même disque : activez les
**sauvegardes du serveur** dans la console Hetzner (Server → Backups : sept sauvegardes quotidiennes), si ce n'est pas
déjà fait pour MyBestConsultant.

### Surveillance

- Le **récapitulatif de 5 h UTC** arrive chaque matin, même sans nouveauté : son absence est le premier signe d'un
  problème.
- Un passage en échec envoie une **alerte** à `MAIL_TO` (« échec du passage du … »), avec la cause et la marche à
  suivre. Si le serveur d'envoi lui-même est en panne, ni l'alerte ni le récapitulatif ne partent : seul le journal le
  dit.
- Ni récapitulatif ni alerte : `sudo -u deploy docker ps --filter name=veille` (le conteneur tourne-t-il ?), puis le
  journal.

### Place disque

Journal limité à 50 Mo (5 fichiers de 10 Mo), 5 images gardées (environ 260 Mo chacune), historique de 30 jours
(quelques Mo).

### Image de base

`NODE_IMAGE` du `Dockerfile` (version et empreinte exactes), la même que celle de MyBestConsultant : montez-les
ensemble, dans les deux dépôts.

## 7. Dépannage

| Symptôme | Cause et correction |
|---|---|
| Déploiement : « un passage de la veille est en cours » | Normal pendant un passage (moins d'une heure) : relancez plus tard. |
| Déploiement : « la version … ne démarre pas ; version précédente remise » | Journal dans le job GitHub et dans `/opt/veille-marches-emplois/deploiement/dernier-deploiement.log`. Souvent « Configuration invalide — <VARIABLE> » : corrigez `veille.env`, puis relancez le déploiement. |
| Déploiement : « lecture de GitHub impossible » | Clé de lecture du dépôt (2.2) : `sudo -u deploy ssh -T github-veille`. |
| Déploiement : « fichier de secrets … absent ou illisible » | `veille.env` manquant ou mauvais droits : 2.4 (`root:deploy`, 640). |
| Déploiement : « deploy/compose.yml refusé — … » | Le commit ajoute au conteneur un réglage que `veille-deploy` n'accepte pas (port, privilège, volume, utilisateur…) : la version précédente reste en ligne. Si le changement est voulu, il faut d'abord modifier `check_compose` de `deploy/veille-deploy.sh` et réinstaller le script (5), après relecture. |
| Déploiement : « archive refusée » | Le flux reçu contient autre chose que la seule image annoncée : rien n'a été chargé. Le workflow normal n'envoie qu'une image ; une autre cause est à examiner (clé SSH exposée ?). |
| Le conteneur redémarre en boucle | `sudo -u deploy docker logs --tail 50 veille`. « Configuration invalide » : `veille.env`, puis `veille-deploy restart`. « EACCES … /data » : droits du dossier (2.1, propriétaire uid 10001). |
| Alerte : « Passage interrompu par un arrêt brutal du conteneur » | Le conteneur a été tué pendant un passage (manque de mémoire, panne, redémarrage du serveur) ; son verrou a été retiré au redémarrage. Les offres déjà envoyées par ce passage repartent au suivant (MyBestConsultant écarte les doublons). Si cela se répète : `docker inspect -f '{{.State.OOMKilled}}' veille` (mémoire). |
| Alerte : envoi interrompu, « délai dépassé » ou « ETIMEDOUT » vers le serveur SMTP | Port bloqué par Hetzner : `SMTP_PORT='587'` (2.4), puis `veille-deploy restart`. |
| « 550 Sender address is not allowed » | `MAIL_FROM` doit être l'adresse de `SMTP_USER` (README, « Configuration »). |
| « 450 Mail send limit exceeded » | Limite horaire du serveur d'envoi : baissez `MAX_OFFER_EMAILS_PER_RUN`. Les offres restantes partent aux passages suivants. |
| Alerte : « Lecture de la boîte AO par MyBestConsultant impossible : HTTP 401 » | `AO_SYNC_TOKEN` ≠ `CRON_SECRET` de MyBestConsultant : corrigez, puis `veille-deploy restart`. Les offres sont bien parties ; MyBestConsultant les lira à son propre passage. |
| Passage à la main : « Un passage est déjà en cours » | Un passage tourne : attendez. Après un arrêt brutal, le verrou est retiré au redémarrage du conteneur, ou repris tout seul au bout de deux heures. |
| Récapitulatif : « Copie du jour de l'état impossible » | Disque plein ou droits de `historique/` : l'état est enregistré, mais l'historique ne l'est plus. |
