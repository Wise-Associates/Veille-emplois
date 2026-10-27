# 0005 — Réglages de la veille dans l'admin de MyBestConsultant

Date : 27 octobre 2026 · Statut : acceptée (les organismes et le filtre de l'ADR 0004 deviennent des données)

## Contexte

Organismes suivis (et règles qui reconnaissent leurs appels d'offres), sources lues et filtre informatique étaient écrits
dans le code (`src/organisations.ts`, `src/sources/sources.ts`, `src/it-scope.ts`) : chaque ajout d'organisme, de code
Choisir le service public ou de mot-clé demandait un développeur et un déploiement. Demande : les régler depuis l'admin
de MyBestConsultant, enregistrés dans sa base Appwrite.

## Décision (27/10/2026)

1. **Les réglages vivent dans MyBestConsultant** : page `/admin/veille` (admin seulement), collection `veille_config`
   (une version par enregistrement, la plus récente en vigueur, 50 gardées ; ADR 0012 de MyBestConsultant).
2. **Le scanner les lit par une route dédiée** (`GET /api/veille/config`, `Authorization: Bearer VEILLE_CONFIG_TOKEN`),
   jamais avec une clé Appwrite : une clé ne se limite pas à une collection et ouvrirait aux secrets de GitHub toute la
   base (candidats compris). Le jeton ne donne accès qu'à ces réglages.
3. **Repli** (choix du 27/10/2026) : MyBestConsultant injoignable ou réglages illisibles → dernière version connue,
   gardée dans `etat.json` (`settings`) ; à défaut, réglages du dépôt (`config/defaults.json`). Les deux replis sont
   signalés dans le récapitulatif (« Réglages de la veille »), qui part alors même en mode « problèmes seulement ».
   La veille ne s'arrête pas parce que le site est indisponible.
4. **Ce qui se règle sans code** : organismes (nom, activé, règles : SIREN, noms d'acheteur, noms exclus, texte exigé,
   et la raison de la règle, `note`) ; sources BOAMP, TED et sites intégrés (activées ou non) ; Choisir le service
   public (codes d'organisme) ; flux RSS officiels de sites carrières, en https, liens d'offres sur le site du
   flux, avec lecture facultative des pages d'offres (données JobPosting de schema.org) ; valeurs du filtre
   informatique. Un site sans flux reste du code (lecteur propre, `BUILTIN`).
5. **Même format dans les deux projets**, validé des deux côtés (`schemaVersion` 1) ; expressions normalisées par le
   scanner (`normalizePhrase`) avant tout usage, ce qui les rend sûres dans une requête BOAMP ou une expression
   régulière. Identifiants d'organismes et de sources = clés du fichier d'état, fixés à leur création.
6. **Premier chargement** : `config/defaults.json`, export exact des réglages codés jusque-là (organismes identiques,
   vérifié), chargé dans MyBestConsultant par `npm run veille:seed` (une seule fois, simulation puis `--apply`).

## Conséquences

- Un changement s'applique au passage suivant (5 h, 9 h, 13 h, 17 h UTC), sans déploiement.
- Supprimer une source puis la recréer sous un autre identifiant renvoie toutes ses offres en ligne ; désactiver la
  garde (son état reste). Élargir le filtre ne renvoie pas les offres déjà écartées (ADR 0004).
- `etat.json` contient désormais la dernière version des réglages (organismes, mots-clés : rien de secret).
- La logique (classification d'abord, sigles en majuscules, homonymes) reste dans le code, avec ses tests ; seuls les
  valeurs et les listes sont des réglages.
- Mise en production : collection et réglages dans MyBestConsultant (`schema:push`, `veille:seed`), variable
  `VEILLE_CONFIG_TOKEN` de MyBestConsultant, secrets `VEILLE_CONFIG_URL` et `VEILLE_CONFIG_TOKEN` du dépôt ; sans eux, le
  scanner tourne sur `config/defaults.json` et le signale à chaque passage.
