# 0002 — Application Nest autonome, lancée par GitHub Actions, état sur une branche Git

Date : 22 octobre 2026 · Statut : acceptée

## Contexte

La veille doit tourner une fois par jour, sans serveur à maintenir, et se souvenir d'un jour à l'autre des annonces
déjà vues. NestJS a été demandé comme cadre.

## Décision

- **NestJS 12 en contexte d'application autonome** (`NestFactory.createApplicationContext`) : pas de serveur HTTP ; le
  processus fait un passage puis s'arrête. Un seul module (`AppModule`) suffit à cette taille.
- **ESM** (NestJS 12 n'est publié qu'en ESM) : `"type": "module"`, imports relatifs en `.js`.
- **Compilation par `tsc`** et non par la CLI Nest, qui exige Node 22.22.3+ (les postes en Node 22.12 ne pourraient
  pas compiler). L'exécution demande Node 22.12+.
- **Tests avec le lanceur intégré de Node (`node:test`)** sur le code compilé par `tsc`, qui émet les métadonnées de
  décorateurs dont l'injection de Nest a besoin. Écartés : Vitest 5 (son installation fait planter npm 10.9, livré
  avec Node 22, sur un cycle de dépendances pairs vite ↔ vitest) et Jest (exige Node 24.9+ avec NestJS 12).
- **Planification par GitHub Actions** (`.github/workflows/veille-quotidienne.yml`, 5 h, 9 h, 13 h et 17 h UTC
  depuis le 23/10/2026 : la limite d'envoi d'IONOS est horaire), en trois jobs : le
  passage s'exécute avec un jeton en lecture seule (une dépendance npm compromise ne peut pas écrire dans le dépôt) ;
  un job sans npm pousse l'état ; un job d'alerte ouvre un ticket en cas d'échec (GitHub ne prévient d'un échec
  planifié que la dernière personne à avoir modifié le cron).
- **État = un fichier JSON versionné sur la branche orpheline `veille-etat`**, récupéré avant le passage et poussé
  après. Historique gratuit (on peut voir et revenir à l'état de n'importe quel jour), aucune infrastructure.

## Conséquences

- Une offre n'est retenue qu'une fois son e-mail parti (détail et codes de sortie : ADR 0003) : un échec d'envoi la
  fait repartir au passage suivant ; un échec après l'envoi (poussée Git) peut produire un doublon, jamais une perte.
- Les appels d'offres encore ouverts sont relus à chaque passage : un passage manqué (panne de GitHub, d'une source) est
  rattrapé au suivant.
- La branche `veille-etat` ne doit pas être protégée contre l'écriture par `github-actions[bot]`, ni supprimée (toutes
  les sources repartiraient de zéro : leurs annonces en ligne seraient réenregistrées sans être annoncées).
