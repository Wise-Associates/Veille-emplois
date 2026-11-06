# 0008 — Lecture de la boîte AO par MyBestConsultant après chaque passage

Date : 1er novembre 2026 · Statut : acceptée (complète l'ADR 0003) ; sur le VPS, l'appel est fait par l'application
elle-même (`src/run/ao-inbox-sync.ts`, ADR 0010), plus par un job à part

## Contexte

Les offres partent par e-mail vers la boîte AO de MyBestConsultant (ADR 0003). MyBestConsultant ne lit cette boîte
que par son passage planifié, une fois par jour (6 h UTC, limite du plan Hobby de Vercel), ou par le bouton
« Synchroniser » : une offre envoyée à 9 h, 13 h ou 17 h attendait jusqu'au lendemain. Demande du 01/11/2026 : faire
lire la boîte par MyBestConsultant à chaque passage de la veille.

MyBestConsultant accepte déjà qu'un planificateur externe appelle `GET /api/cron/ao-inbox` avec
`Authorization: Bearer <CRON_SECRET>`. Chaque appel lit au plus 25 e-mails en 4 minutes et renvoie un compte rendu
(`processed`, `remaining`, `skipped`, `aiUnavailable`).

## Décision

1. Un job `synchroniser` du workflow `veille-quotidienne.yml`, après `passage`, seulement après un vrai passage
   (jamais en essai), même si un envoi a échoué.
2. Ce job n'exécute que `curl` et `jq` : ni le code du projet, ni npm. Le secret de MyBestConsultant n'est donné à
   aucune dépendance. Permissions GitHub : aucune.
3. Secrets `AO_SYNC_URL` (`https://<site de production>/api/cron/ao-inbox`) et `AO_SYNC_TOKEN` (le `CRON_SECRET`
   de production de MyBestConsultant). Sans eux, le job ne fait rien et l'indique.
4. Il attend 30 secondes, le temps que les derniers e-mails arrivent dans la boîte. Ensuite, il rappelle la route
   tant qu'il reste des e-mails, pendant 15 minutes au plus. Il s'arrête plus tôt dans trois cas :
   - tout est lu ;
   - rien n'a avancé ;
   - l'IA est indisponible : avertissement dans le journal.

   Si une autre lecture est en cours (`skipped`), il réessaie 30 secondes plus tard.
5. Une réponse en erreur (401, 502 « aucune boîte lisible », 500) ou un site injoignable fait échouer le job, ce qui
   ouvre le ticket d'incident. Seul le message générique est écrit dans le journal GitHub. Le détail, qui peut nommer
   des boîtes, reste dans les journaux de Vercel.

## Conséquences

- Les offres apparaissent dans MyBestConsultant dans les minutes qui suivent leur envoi. Au-delà de 15 minutes de
  lecture (passage de 200 offres), le reste est lu au passage suivant ou par le passage quotidien de Vercel.
- La route lit les boîtes de **toutes** les organisations, pas seulement celle de la plateforme : chaque passage de la
  veille fait aussi avancer leurs boîtes (appels d'IA compris).
- Jusqu'à 20 minutes d'Actions de plus par passage pendant un rattrapage, quelques secondes sinon.
- `CRON_SECRET` sert aussi aux autres routes planifiées de MyBestConsultant (désactivation des offres expirées,
  purge de l'assistant). Un jeton propre à cette route serait plus étroit, mais demanderait une nouvelle variable en
  production. **Changer `CRON_SECRET` dans Vercel oblige à changer `AO_SYNC_TOKEN` ici**, sinon le job échoue en 401.
