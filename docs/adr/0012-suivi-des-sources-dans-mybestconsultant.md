# 0012 — Suivi des sources dans MyBestConsultant

Date : 10 novembre 2026 · Statut : acceptée (complète les ADR 0003 et 0005)

## Contexte

L'état de chaque source (lecture réussie ou en échec, annonces lues, écartées, envoyées) n'était visible que dans le
journal du conteneur et dans le récapitulatif envoyé à l'équipe, et MyBestConsultant ne savait pas de quelle source
venait une offre reçue dans sa boîte AO. Demande du 2026-11-10 : suivre les AO de chaque source configurée dans
`/admin/veille`, dans les statistiques AO de MyBestConsultant (ADR 0030 de MyBestConsultant).

## Décision

1. **Chaque e-mail d'offre porte `X-Wise-Veille-Source: <identifiant de la source>`** (`VEILLE_SOURCE_HEADER`,
   `src/mail/mailer.ts`), à côté de `X-Wise-Veille: scraping`. Un identifiant qui n'a pas la forme `[a-z0-9-]{1,50}`
   n'est pas écrit (l'offre part quand même ; MyBestConsultant la range sous « source inconnue »).
2. **Rapport du passage** (`buildRunReport`, `src/run/source-report.ts`, règle pure testée) : par source, statut,
   erreur, annonces lues, nouvelles écartées hors informatique, nouvelles, envoyées, échues, en attente, et les points
   à vérifier rattachés par le libellé de la source ; les autres (réglages, fichier d'état, serveur d'envoi) à part.
   Messages coupés à 300 caractères, 20 alertes par source et 50 hors source : MyBestConsultant refuse au-delà.
   Seulement des nombres, des libellés et des messages d'erreur (au plus l'intitulé public d'une offre refusée par le
   serveur d'envoi) : jamais le texte d'une annonce ni un contact.
3. **Envoi** (`SourceReportSender`, `src/run/source-report-sender.ts`) : `POST` à l'adresse des réglages dont
   `/config` devient `/runs` (aucune nouvelle variable), avec `VEILLE_CONFIG_TOKEN`, délai de 15 s, une nouvelle
   tentative (sans risque : MyBestConsultant ignore un passage déjà reçu), redirection vers une autre origine refusée.
   Fait par `ScanService.run` **après l'enregistrement de l'état**, avant le récapitulatif. Jamais en essai.
4. **Un rapport non transmis ne fait pas échouer le passage** : les offres sont parties et l'état est enregistré ; il
   devient le point à vérifier « Suivi des sources (MyBestConsultant) » du récapitulatif (envoyé même en mode
   « problèmes seulement »).

## Conséquences

- Le format du rapport est partagé avec `src/lib/veille/run-report.ts` de MyBestConsultant (`schemaVersion`) : toute
  évolution dans les deux projets. L'en-tête `X-Wise-Veille-Source` ne se renomme pas sans changer les deux.
- Ordre de mise en place : MyBestConsultant d'abord (structure, variable, code), puis ce projet. Dans l'autre ordre,
  chaque passage signale un rapport non transmis (404 ou 503) jusqu'à la mise à jour de MyBestConsultant.
- Un passage interrompu avant l'enregistrement de l'état n'envoie pas de rapport : MyBestConsultant signale l'absence
  de rapport depuis 13 heures, en plus de l'alerte e-mail de `VeilleRunner`.
