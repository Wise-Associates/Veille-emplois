# Image de la veille marchés et emplois (ADR 0010) : un processus Node qui reste lancé et fait les passages planifiés
# (node dist/main.js --schedule). Construite par .github/workflows/deploy-vps.yml, lancée sur le VPS par
# deploy/veille-deploy.sh avec deploy/compose.yml. Guide : docs/deploiement-vps.md.
#
# Construction et essai à la main (lit les sources, n'envoie rien, n'a besoin d'aucun secret) :
#   docker build -t veille-marches-emplois:essai .
#   docker run --rm --read-only --tmpfs /tmp veille-marches-emplois:essai node dist/main.js --dry-run

# Node 24 (LTS), comme .nvmrc et la CI ; même image que MyBestConsultant, sur le même serveur. Version et empreinte
# exactes (une étiquette peut être republiée) : les monter ensemble (docker buildx imagetools inspect node:<version>).
ARG NODE_IMAGE=node:24.22.1-trixie-slim@sha256:89c5244bc22a9bc3287d89ebc7e49b9cb5bb84cd40e6175ac3421d5a9f68b95a

FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Dépendances d'abord : cette couche est réutilisée tant que package-lock.json ne change pas. --ignore-scripts : aucune
# dépendance n'a de script d'installation légitime, on n'en exécute aucun (comme en CI).
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Dépendances d'exécution seulement (sans TypeScript ni outils de test).
FROM ${NODE_IMAGE} AS runtime-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE}
WORKDIR /app
# NO_COLOR : journaux sans codes de couleur (docker logs). STATE_FILE : dossier du serveur monté sur /data
# (deploy/compose.yml) ; l'historique quotidien va dans /data/historique.
ENV NODE_ENV=production \
    NO_COLOR=1 \
    STATE_FILE=/data/etat.json
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# config/defaults.json : réglages de dernier recours, lus au démarrage (src/settings/defaults.ts).
COPY package.json ./
COPY config ./config
# Utilisateur sans privilège et sans compte sur le serveur (uid 10001, pas celui de « node », 1000, qui est souvent le
# premier compte d'administration du serveur) : le dossier /data du serveur lui appartient. Rien d'autre n'est écrit
# que /data et /tmp ; le code de /app reste à root, en lecture seule.
USER 10001:10001
CMD ["node", "--enable-source-maps", "dist/main.js", "--schedule"]
