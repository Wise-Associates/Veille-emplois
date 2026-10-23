# 0003 — Une offre par e-mail, vers la boîte AO de MyBestConsultant

Date : 22 octobre 2026 · Statut : acceptée (remplace le récapitulatif unique de l'ADR 0002 comme sortie principale)

## Contexte

Les offres relevées doivent arriver dans la boîte AO de MyBestConsultant et suivre son circuit de publication :
lecture par l'IA, offres « à valider », publication anonymisée par un administrateur. Or MyBestConsultant, pour un
e-mail reçu :

- confie le corps à son IA, dont la réponse est coupée au-delà d'une dizaine d'offres (50 au plus par e-mail) ;
- ne garde qu'une date limite par e-mail ;
- prend pour client l'entreprise de l'expéditeur, sauf si l'expéditeur est de ses propres domaines (ADR 0004 de
  MyBestConsultant) : le client est alors celui que cite le texte.

Le récapitulatif quotidien d'origine (toutes les offres dans un seul e-mail, titres seulement) ne convient donc pas.

## Décision (22/10/2026)

1. **Chaque nouvelle offre part dans son propre e-mail** vers `OFFERS_TO`, avec des libellés que la consigne
   d'extraction de MyBestConsultant attend (Intitulé, Client, Lieu, Date limite…) et **le texte complet de l'annonce**.
   Le texte vient de la liste quand la source le donne, sinon de la page de l'offre, lue au moment de l'envoyer
   (Choisir le service public : employeur, date limite ; Expertise France ; La Banque Postale).
2. **Premier passage : toutes les offres en ligne sont envoyées** (environ 750 en octobre 2026), plus de
   « source lue pour la première fois » silencieuse.
3. **Plafond par passage** (`MAX_OFFER_EMAILS_PER_RUN`, 200 par défaut) et **une offre par seconde** : les serveurs
   d'envoi bloquent les rafales, et la boîte AO est lue par lots. Ordre : appels d'offres, puis offres d'emploi, par
   organisme. Le reste attend les passages suivants (relance manuelle possible).
4. **Une offre n'est retenue comme envoyée qu'après acceptation de son e-mail** par le serveur SMTP. Au premier refus
   (quota, adresse), l'envoi s'arrête ; les offres non envoyées redeviennent nouvelles (`forgetUnsent`).
5. **Un récapitulatif** part ensuite vers l'équipe (`MAIL_TO`) : offres envoyées, en attente, points à vérifier.
6. L'état est enregistré **avant** le récapitulatif. Si le récapitulatif ou un envoi échoue après l'enregistrement,
   le processus sort avec le code 3 et le workflow pousse quand même l'état (sinon les offres déjà envoyées
   repartiraient), puis ouvre le ticket d'incident.

## Conséquences

- Le premier déploiement remplit la boîte AO pendant plusieurs jours (environ 750 offres, 200 par passage), et
  chaque e-mail est lu par l'IA de MyBestConsultant : coût d'IA et volume « à valider » à prévoir.
- `MAIL_FROM` doit être une adresse des domaines de l'organisation (`@wise-associates.fr`), sinon toutes les offres
  auraient pour client l'entreprise de l'expéditeur dans MyBestConsultant.
- Les descriptions peuvent contenir le nom d'un recruteur ; elles ne vont que dans la boîte AO interne, et la consigne
  de MyBestConsultant retire les coordonnées des offres qu'elle extrait. Rien n'est journalisé.
- **Publication** : la boîte AO ne publie rien d'elle-même, un administrateur valide. Avant de publier une offre
  relevée ici, vérifier que c'est bien une mission que Wise Associates peut pourvoir (une offre d'emploi d'un
  organisme public est un recrutement de cet organisme), et les conditions de réutilisation de la source
  (Choisir le service public : licence Etalab 2.0, citer la source ; SFIL : accord écrit préalable).
- Un passage tué par le délai maximal du job (40 minutes) n'enregistrerait rien : les offres de ce passage
  repartiraient le lendemain. D'où un **budget de temps** (`RUN_TIME_BUDGET_MS`, 25 minutes) au-delà duquel plus
  aucune offre n'est commencée (le reste attend, comme au-delà du plafond), des lectures de pages courtes (15 s, sans
  nouvelle tentative) abandonnées pour une source après 3 échecs de suite, et un ticket ouvert aussi quand le job est
  annulé par son délai.
- Un message refusé pour lui-même (code 5xx après DATA : contenu, taille) est sauté et retenté au passage suivant ;
  les autres refus (connexion, identifiants, expéditeur, quota) arrêtent l'envoi. Dans les deux cas : code 3, ticket.
