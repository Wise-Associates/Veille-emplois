# 0009 — Avis officiel en PDF joint, lien vers le dossier de consultation

Date : 5 novembre 2026 · Statut : acceptée

## Contexte

Demande du 05/11/2026 : pour les appels d'offres du BOAMP et de TED, aller plus loin que le texte de l'avis, avec le
détail de l'avis et ses PDF. Relevé du même jour, sur les avis réels :

- Les pages d'un avis (boamp.fr, ted.europa.eu) sont construites à partir des mêmes données que les API déjà lues
  (ADR 0001) : il n'y a pas de page HTML à lire en plus.
- **L'avis officiel en PDF** se télécharge librement sur les deux sites (50 à 270 Ko), sous la licence de leurs données
  (Licence Ouverte, décision de la Commission du 12/12/2011), et leur robots.txt n'interdit pas ces adresses :
  - BOAMP : `https://www.boamp.fr/telechargements/FILES/PDF/<année>/<mois de parution>/<idweb>.pdf`, la règle qu'applique
    la page d'un avis aux données du schéma 3 (100 avis ouverts sur 100 relevés) ;
  - TED : `https://ted.europa.eu/fr/notice/<numéro>/pdf`, l'adresse que donne le champ `links` de l'API.

  16 avis informatiques ouverts sur 16 essayés ont été téléchargés.
- **Le dossier de consultation** (DCE : règlement, CCTP, CCAP) n'est ni au BOAMP ni à TED. Il est sur la plateforme
  de chaque acheteur (PLACE, marches-publics.info, achatpublic, Maximilien…), derrière une connexion ou une page de
  conditions. PLACE et marches-publics.info interdisent toute reprise sans autorisation écrite (ADR 0001). L'avis
  donne le lien du dossier ou celui du profil d'acheteur : c'était le cas de 104 avis informatiques ouverts sur 108.
- MyBestConsultant lit le texte des PDF joints aux e-mails de sa boîte AO (lecture locale, sans IA d'image). Chaque
  pièce jointe se télécharge depuis la page de l'offre.

## Décision (05/11/2026, avec l'utilisateur)

1. **L'avis officiel en PDF est joint à l'e-mail** de chaque appel d'offres du BOAMP et de TED (en français pour TED),
   sous le nom `avis-<référence>.pdf`. Le texte de l'e-mail l'annonce : « Avis officiel (PDF) : joint à cet e-mail ».
2. **Téléchargement** au moment d'envoyer l'offre, après l'écart des offres échues (`src/tenders/notice-pdf.ts`) :
   - depuis `www.boamp.fr` et `ted.europa.eu` seulement, en https, redirections comprises ;
   - adresse construite par la source à partir de l'identifiant de l'avis, jamais reprise du contenu de l'avis ;
   - délai de 15 s, sans nouvelle tentative ;
   - contenu vérifié (signature `%PDF-`) ; lecture arrêtée au-delà de 5 Mo (un avis fait 50 à 300 Ko), un message
     trop lourd étant refusé par le serveur d'envoi.
3. **Un échec n'empêche pas l'envoi.** L'offre part sans son PDF, son e-mail garde le lien de l'avis, et le
   récapitulatif le signale. Une offre partie sans son PDF n'est pas renvoyée plus tard.
   - Après 3 échecs de suite dus au site (injoignable, délai dépassé, erreur 429 ou 5xx), plus aucun téléchargement pour
     cette source pendant le passage. Un avis introuvable (404) ou un fichier refusé ne concerne que cet avis : il ne
     rapproche pas de cet arrêt (revue du 05/11/2026 : trois avis introuvables de suite privaient de PDF tous les
     suivants).
   - Un message refusé pour lui-même par le serveur d'envoi alors qu'il portait le PDF (taille, filtre) est renvoyé
     aussitôt sans le PDF, et le récapitulatif le signale. Sans cela, l'offre repartirait à chaque passage avec le même
     PDF et serait refusée chaque fois.
4. **Le dossier de consultation n'est jamais téléchargé.** L'e-mail donne son lien, ou à défaut celui du profil
   d'acheteur (« Dossier de consultation »). Le lien est saisi par l'acheteur et rendu cliquable : http(s) sur un nom de
   domaine seulement, sans identifiants (« https://site-officiel@autre-site/… » mène à autre-site) ni adresse IP
   (`webUrl`, `src/text.ts`).
5. **Contacts nominatifs** : l'avis PDF nomme le contact de l'acheteur. Avec l'accord de l'utilisateur, il est joint
   tel quel à la boîte AO interne. La veille ne lit ni ne journalise son contenu, et ne reprend toujours aucun contact
   dans le texte de l'e-mail ni dans les journaux.

## Conséquences

- Un e-mail d'appel d'offres pèse 100 à 400 Ko (PDF encodé en base64). Les limites du serveur d'envoi portent sur le
  nombre de messages, pas sur leur taille.
- Une requête de plus par appel d'offres envoyé, moins d'une seconde ; les envois restent limités à un par seconde.
- MyBestConsultant confie le texte du PDF à son IA avec le corps de l'e-mail : plus de texte lu par offre (coût
  d'IA). Le contact de l'acheteur peut alors apparaître dans « Contact client » de la page de l'offre (interne, jamais
  publié). À vérifier sur les premières offres reçues : une seule offre par e-mail, le corps et le PDF décrivant le
  même avis.
- Les offres déjà envoyées ne sont pas renvoyées avec leur PDF.
- Si le BOAMP change d'adresse ou de schéma de données, les téléchargements échouent et le récapitulatif le signale
  à chaque passage : corriger `boampNoticePdfUrl` (`src/sources/boamp.source.ts`) d'après le lien « PDF » de la page
  d'un avis.
- Télécharger le dossier de consultation demanderait l'autorisation écrite de chaque plateforme et un compte par
  plateforme : hors périmètre.
