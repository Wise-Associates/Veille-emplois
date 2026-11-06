#!/usr/bin/env bash
# Déploiement de la veille sur le VPS (ADR 0010, docs/deploiement-vps.md). Installé sur le serveur en
# /usr/local/bin/veille-deploy (propriété de root) ; tourne sous l'utilisateur deploy.
#
# Appelé par GitHub Actions par SSH, avec une clé limitée à cette commande :
#   docker save veille-marches-emplois:<commit> | gzip | ssh deploy@<vps> deploy <commit>
# À la main sur le serveur :
#   sudo -u deploy veille-deploy status               version en ligne, conteneur, images gardées
#   sudo -u deploy veille-deploy rollback <commit>    remet une version dont l'image est encore sur le serveur
#   sudo -u deploy veille-deploy restart              relance la version en ligne (après une modification de veille.env)
#   sudo -u deploy veille-deploy restore <AAAA-MM-JJ> remet l'état de la veille de ce jour (historique/)
#
# Déroulé d'un déploiement : archive vérifiée (une seule image, celle annoncée) → image chargée → fichiers deploy/ du
# même commit (git) → forme du conteneur vérifiée → conteneur remplacé et en bonne santé (planification en place). Si la
# nouvelle version ne démarre pas, la précédente est remise. Un seul conteneur : la veille ne sert aucune requête, un
# redémarrage de quelques secondes ne coupe rien (sauf s'il tombe pile à l'heure d'un passage, qui est alors sauté ;
# ses offres partent au suivant).
#
# Ce script est la barrière du serveur (partagé avec MyBestConsultant) : un commit de main ne peut ni modifier ce qu'il
# vérifie (copie installée à part), ni donner au conteneur plus que ce que check_compose accepte.
set -euo pipefail

ROOT=${VEILLE_ROOT:-/opt/veille-marches-emplois}
REPO=$ROOT/repo
STATE=$ROOT/deploiement
DATA=$ROOT/donnees
# Secrets et réglages de production (root, lisible par deploy).
ENV_FILE=${VEILLE_ENV_FILE:-/etc/veille-marches-emplois/veille.env}
LOG=$STATE/dernier-deploiement.log
IMAGE=veille-marches-emplois
# Utilisateur du conteneur, sans compte sur le serveur (deploy/compose.yml, Dockerfile) : propriétaire de $DATA.
APP_USER=10001:10001
# Images gardées sur le serveur pour un retour arrière sans GitHub.
KEEP_IMAGES=5
# Une image fait environ 260 Mo ; au-delà, l'archive envoyée est refusée (disque partagé avec MyBestConsultant).
MAX_ARCHIVE_BYTES=$((1024 * 1024 * 1024))
# Au-delà, le verrou d'un passage est abandonné (STALE_LOCK_MS de src/state/state-store.ts).
STALE_LOCK_SECONDS=7200

log() { printf '[veille-deploy] %s\n' "$*" >&2; }
die() { log "ÉCHEC : $*"; exit 1; }

# `sudo -u deploy veille-deploy …` garde le dossier courant de l'administrateur, où deploy n'a pas le droit d'entrer :
# docker compose échoue alors (« stat .: permission denied »). Toujours partir d'ici.
cd "$ROOT" || die "dossier $ROOT introuvable ou inaccessible pour $(id -un)"

app_compose() { # commit arguments…
  IMAGE_TAG=$1 VEILLE_ENV_FILE=$ENV_FILE VEILLE_DATA=$DATA docker compose -p veille -f "$REPO/deploy/compose.yml" "${@:2}"
}

# Forme attendue du conteneur (deploy/compose.yml) : rien de plus que ce qui y est écrit aujourd'hui. Un compose.yml
# modifié sur main (privilège, volume du serveur, port, réseau de l'hôte, autre utilisateur) est refusé avant tout
# démarrage. « docker compose config » y recopie les secrets de veille.env : seuls des noms de réglages sont affichés.
COMPOSE_CHECK=$(
  cat << 'PY'
import json, sys
data, image, user = sys.argv[1], sys.argv[2], sys.argv[3]
config = json.load(sys.stdin)
problems = []
extra = sorted(set(config) - {"name", "networks", "services"})
if extra:
    problems.append("sections en plus : " + ", ".join(extra))
networks = config.get("networks") or {}
if set(networks) - {"default"} or set(networks.get("default") or {}) - {"name", "ipam"} or (networks.get("default") or {}).get("ipam") not in (None, {}):
    problems.append("réseaux : seulement celui par défaut")
services = config.get("services") or {}
if set(services) != {"veille"}:
    problems.append("services : seulement « veille »")
service = services.get("veille") or {}
allowed = {"cap_drop", "command", "container_name", "entrypoint", "environment", "healthcheck", "image", "init", "logging",
           "mem_limit", "networks", "pids_limit", "read_only", "restart", "security_opt", "stop_grace_period", "tmpfs",
           "user", "volumes"}
extra = sorted(set(service) - allowed)
if extra:
    problems.append("réglages en plus : " + ", ".join(extra))
expected = {"image": image, "user": user, "read_only": True, "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
            "container_name": "veille", "init": True, "command": None, "entrypoint": None, "networks": {"default": None}}
for key, value in expected.items():
    if service.get(key) != value:
        problems.append(key + " : valeur inattendue")
volumes = service.get("volumes") or []
volume = volumes[0] if len(volumes) == 1 else {}
if (len(volumes) != 1 or set(volume) - {"type", "source", "target", "bind"} or volume.get("type") != "bind"
        or volume.get("source") != data or volume.get("target") != "/data" or volume.get("bind") not in (None, {}, {"create_host_path": True})):
    problems.append("volumes : seulement le dossier d'état, sur /data")
if any(not isinstance(entry, str) or not entry.startswith("/tmp:") for entry in service.get("tmpfs") or []):
    problems.append("tmpfs : /tmp seulement")
if problems:
    print("deploy/compose.yml refusé — " + " ; ".join(problems), file=sys.stderr)
    sys.exit(1)
PY
)

# Archive envoyée par GitHub : une seule image, celle annoncée. « docker load » donnerait sinon à d'autres images les
# noms qu'elle contient, y compris ceux des images gardées de MyBestConsultant ou de la veille (retour arrière piégé).
ARCHIVE_CHECK=$(
  cat << 'PY'
import json, sys, tarfile
archive, image = sys.argv[1], sys.argv[2]
repository, tag = image.rsplit(":", 1)
def refuse(reason):
    print("archive refusée — " + reason, file=sys.stderr)
    sys.exit(1)
try:
    with tarfile.open(archive) as tar:
        names = set(tar.getnames())
        read = lambda name: json.load(tar.extractfile(name))
        if "manifest.json" not in names:
            refuse("manifest.json absent")
        manifest = read("manifest.json")
        if not isinstance(manifest, list) or len(manifest) != 1 or manifest[0].get("RepoTags") != [image]:
            refuse("manifest.json : une seule image, " + image)
        if "repositories" in names:
            repositories = read("repositories")
            if set(repositories) != {repository} or set(repositories[repository]) != {tag}:
                refuse("repositories : une seule image, " + image)
        if "index.json" in names:
            entries = read("index.json").get("manifests") or []
            if len(entries) != 1 or entries[0].get("mediaType") != "application/vnd.oci.image.manifest.v1+json":
                refuse("index.json : une seule image")
            annotations = entries[0].get("annotations") or {}
            if annotations.get("io.containerd.image.name") not in (None, "docker.io/library/" + image) or annotations.get("org.opencontainers.image.ref.name") not in (None, tag):
                refuse("index.json : une seule image, " + image)
except (tarfile.TarError, OSError, ValueError, KeyError, AttributeError) as error:
    refuse("illisible (" + type(error).__name__ + ")")
PY
)

# Vérifie la forme du conteneur du commit, puis le démarre et attend sa bonne santé. Code de retour non nul en cas
# d'échec (l'appelant décide de la suite).
start_version() { # commit [arguments de up…]
  app_compose "$1" config --format json | python3 -I -c "$COMPOSE_CHECK" "$DATA" "$IMAGE:$1" "$APP_USER" || return 1
  app_compose "$1" up --detach --wait --wait-timeout 120 "${@:2}"
}

show_status() {
  if [[ -f $STATE/active-commit ]]; then log "en ligne : commit $(<"$STATE/active-commit")"; else log "aucune version déployée"; fi
  docker ps --all --filter 'name=^veille$' --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
  log "images présentes (retour arrière possible) :"
  docker image ls "$IMAGE" --format '  {{.Tag}}  {{.CreatedSince}}'
  log "journal du dernier déploiement : $LOG"
}

# Un passage en cours empêche le remplacement du conteneur pendant jusqu'à 35 minutes (il va au bout avant l'arrêt) :
# refusé tout de suite plutôt que d'attendre. Seul un verrou daté dans les deux dernières heures bloque : un verrou
# abandonné, illisible ou daté dans le futur (écrit par le conteneur, il ne doit pas pouvoir bloquer un retour arrière)
# est ignoré.
refuse_during_run() {
  local lock=$DATA/etat.json.lock since age
  [[ -f $lock ]] || return 0
  since=$(sed -n 's/.*"since":"\([^"]*\)".*/\1/p' "$lock")
  if [[ $since =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ ]]; then
    age=$(($(date +%s) - $(date -d "$since" +%s)))
    if ((age >= 0 && age < STALE_LOCK_SECONDS)); then
      die "un passage de la veille est en cours (commencé à $since) ; relancez dans une demi-heure"
    fi
  fi
  log "verrou de passage abandonné, illisible ou daté dans le futur ($lock) : ignoré"
}

# Par SSH, la commande demandée arrive dans SSH_ORIGINAL_COMMAND (clé limitée par command= dans authorized_keys).
read -r -a args <<< "${SSH_ORIGINAL_COMMAND:-$*}"
action=${args[0]:-}
argument=${args[1]:-}
case $action in
  status)
    show_status
    exit 0
    ;;
  restart)
    [[ ${#args[@]} -eq 1 ]] || die "usage : restart"
    ;;
  restore)
    [[ ${#args[@]} -eq 2 && $argument =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "usage : restore <AAAA-MM-JJ>"
    ;;
  deploy | rollback)
    [[ ${#args[@]} -eq 2 && $argument =~ ^[0-9a-f]{40}$ ]] || die "usage : $action <commit complet de 40 caractères>"
    ;;
  *)
    die "usage : deploy <commit> | rollback <commit> | restart | restore <AAAA-MM-JJ> | status"
    ;;
esac

[[ -r $ENV_FILE ]] || die "fichier de secrets $ENV_FILE absent ou illisible pour $(id -un) (guide, partie 2)"
[[ -d $DATA ]] || die "dossier d'état $DATA absent (guide, partie 2)"
mkdir -p "$STATE"
exec 9> "$STATE/deploy.lock"
flock -n 9 || die "un autre déploiement est en cours"
# Si la connexion SSH tombe (workflow annulé, réseau), le déploiement va quand même au bout : signaux de fin de session
# ignorés, sortie recopiée dans $LOG par tee, qui continue d'écrire le fichier quand la connexion est fermée (-p).
trap '' HUP PIPE
exec > >(tee -p "$LOG" >&2) 2>&1

previous_commit=""
if [[ -f $STATE/active-commit ]]; then previous_commit=$(<"$STATE/active-commit"); fi

if [[ $action == restart ]]; then
  [[ -n $previous_commit ]] || die "aucune version déployée"
  refuse_during_run
  log "relance de la version $previous_commit (fichier de secrets relu)"
  start_version "$previous_commit" --force-recreate || die "la version ne redémarre pas : docker logs veille"
  log "terminé"
  exit 0
fi

if [[ $action == restore ]]; then
  [[ -n $previous_commit ]] || die "aucune version déployée"
  refuse_during_run
  log "arrêt de la veille (un passage en cours irait au bout)"
  docker stop veille > /dev/null || die "la veille ne s'arrête pas : docker ps --filter name=veille"
  # Copie faite dans un conteneur de l'image, sous l'utilisateur de la veille, sans réseau : un lien symbolique posé
  # dans le dossier d'état ne peut viser que des fichiers de ce conteneur, jamais ceux du serveur (secrets de
  # MyBestConsultant). --remove-destination : etat.json remplacé, jamais écrit à travers un lien.
  if ! docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --user "$APP_USER" \
    -v "$DATA:/data" --entrypoint cp "$IMAGE:$previous_commit" \
    --remove-destination "/data/historique/etat-$argument.json" /data/etat.json; then
    docker start veille > /dev/null || log "ATTENTION : la veille ne redémarre pas : docker logs veille"
    die "copie impossible (historique/etat-$argument.json absent ?) ; état inchangé, veille relancée"
  fi
  docker start veille > /dev/null || die "état du $argument remis, mais la veille ne redémarre pas : docker logs veille"
  log "état du $argument remis ; veille relancée"
  exit 0
fi

commit=$argument
# Le commit annoncé doit être dans main (vérifié avant de lire l'image). Le contenu de l'image, lui, n'est pas
# vérifiable ici : la clé SSH de GitHub Actions vaut un accès au conteneur et à ses secrets (voir le guide).
git -C "$REPO" fetch --quiet origin main || die "lecture de GitHub impossible (clé de déploiement du dépôt ?)"
git -C "$REPO" merge-base --is-ancestor "$commit" origin/main || die "le commit $commit n'est pas dans la branche main"

image=$IMAGE:$commit
if [[ $action == deploy ]]; then
  archive=$(mktemp "$STATE/image.XXXXXX.tar")
  # Lecture bornée : un flux plus gros est coupé, donc illisible, donc refusé.
  if ! gunzip | head -c "$MAX_ARCHIVE_BYTES" > "$archive"; then
    rm -f "$archive"
    die "flux de l'image illisible"
  fi
  if ! python3 -I -c "$ARCHIVE_CHECK" "$archive" "$image"; then
    rm -f "$archive"
    die "archive refusée : seule l'image $image est acceptée (rien n'a été chargé)"
  fi
  log "chargement de l'image $image"
  loaded=$(docker load --input "$archive") || {
    rm -f "$archive"
    die "chargement de l'image impossible"
  }
  rm -f "$archive"
  [[ $loaded == "Loaded image: $image" ]] || die "chargement inattendu : ${loaded//$'\n'/ ; }"
fi
docker image inspect "$image" > /dev/null 2>&1 || die "image $image absente du serveur"

refuse_during_run

# Fichiers de déploiement (compose) du commit déployé : la configuration suit le code.
log "fichiers de déploiement du commit $commit"
git -C "$REPO" checkout --quiet --detach "$commit"
if ! cmp -s "${BASH_SOURCE[0]}" "$REPO/deploy/veille-deploy.sh"; then
  log "ATTENTION : deploy/veille-deploy.sh diffère de la copie installée ; réinstallez-la (guide, « Mettre à jour veille-deploy »)"
fi

log "démarrage de la version $commit"
if ! start_version "$commit"; then
  log "journaux de la version $commit :"
  docker logs --tail 80 veille || log "(pas de conteneur, ou journaux illisibles)"
  if [[ -z $previous_commit ]]; then
    app_compose "$commit" down || log "le conteneur n'a pas pu être retiré : docker rm -f veille"
    git -C "$REPO" checkout --quiet --detach origin/main
    die "la version $commit ne démarre pas ; aucune version précédente"
  fi
  log "remise de la version précédente $previous_commit"
  git -C "$REPO" checkout --quiet --detach "$previous_commit"
  start_version "$previous_commit" || log "ATTENTION : la version précédente ne redémarre pas non plus : docker logs veille"
  die "la version $commit ne démarre pas ; version précédente remise"
fi
printf '%s\n' "$commit" > "$STATE/active-commit.new"
mv "$STATE/active-commit.new" "$STATE/active-commit"

# Seules les KEEP_IMAGES images les plus récentes sont gardées (la version en ligne toujours).
mapfile -t old_tags < <(docker image ls "$IMAGE" --format '{{.CreatedAt}}\t{{.Tag}}' | sort -r | cut -f2 | tail -n +$((KEEP_IMAGES + 1)))
for tag in "${old_tags[@]}"; do
  [[ $tag == "$commit" ]] && continue
  docker image rm "$IMAGE:$tag" > /dev/null || log "image $IMAGE:$tag non supprimée (place disque à surveiller)"
done
log "terminé : version $commit en ligne"
