# 0011 — Date limite des appels d'offres : données eForms, puis avis officiel en PDF

Date : 10 novembre 2026 · Statut : acceptée · Modifie le point 5 de l'ADR 0009

## Contexte

Audit de la boîte AO de production (MyBestConsultant), le 10/11/2026 : 7 appels d'offres du BOAMP étaient arrivés
**sans date limite**, dont 5 déjà clos à leur arrivée (le plus ancien depuis le 31/07/2026). Tous sont des avis
européens (« Marchés européens », eForms) en procédure restreinte ou négociée :

- le champ `datelimitereponse` de l'API du BOAMP est **vide** pour eux ; la requête les garde (« un avis sans date
  limite est gardé : rien ne dit qu'il est clos ») et l'e-mail partait sans ligne « Date limite de réponse » ;
- la date est pourtant dans le contenu de l'avis (`donnees`, eForms) : `cac:ParticipationRequestReceptionPeriod`
  (demandes de participation) ou `cac:TenderSubmissionDeadlinePeriod` (offres), dans chaque lot ;
- elle est aussi écrite dans l'avis officiel en PDF, déjà téléchargé et joint (ADR 0009) : « Date limite de réception
  des demandes de participation : 30/11/2026 à 12:00 » (BOAMP), « Date limite de réception des offres : 04/11/2026
  11:00:00 (UTC+02:00) » (TED).

Sans date, la veille ne pouvait pas écarter ces avis échus, et MyBestConsultant ne les signalait pas.

TED n'est pas concerné : sa requête exige `deadline-receipt-tender-date-lot`, chaque avis lu en a une. Les offres
d'emploi gardent leurs sources de date (page de l'offre, `validThrough`) ; les sites sans date (La Banque Postale,
SFIL, relevé du 10/11/2026) n'en ont nulle part.

## Décision (10/11/2026, avec l'utilisateur)

1. **Données eForms** : pour un avis du BOAMP sans `datelimitereponse`, la date limite vient des périodes ci-dessus,
   dans tout l'avis (`boampEformsDeadline`, `src/sources/boamp.source.ts`), avec l'heure et le fuseau écrits. Plusieurs
   dates (lots, candidatures puis offres) : la plus proche **encore à venir**, et toutes passées, la plus tardive
   (`pickDeadline`, `src/dates.ts`) ; un avis dont un lot reste ouvert n'est jamais écarté comme échu (revue du
   10/11/2026).
1 bis. **Avis rectificatifs** : un rectificatif peut repousser la date (avis réel de juillet 2026 : 31/07 → 31/08 →
   07/09, trois rectificatifs). Pour chaque avis encore inconnu de la veille, le dernier rectificatif (`annonce_lie`,
   `etat="RECTIFICATIF"`, une requête par lot de 50 avis) donne la date s'il en a une (`boampDeadline`). Sans réponse du
   BOAMP, la source échoue (signalée) et ses avis restent nouveaux : jamais un avis prolongé écarté à tort.
2. **Avis PDF en dernier recours** : un appel d'offres encore sans date après les données de la source et la page de
   l'offre voit son avis PDF téléchargé **avant** le contrôle des offres échues, puis son texte lu pour la seule ligne
   de date limite (`deadlineFromNoticeText`, `src/tenders/notice-deadline.ts`) ; la plus proche si l'avis en donne
   plusieurs, jamais la date limite des questions. Le même PDF est ensuite joint : un seul téléchargement. Une date
   trouvée passée : l'offre n'est pas envoyée et elle est retenue comme traitée.
3. **Contacts nominatifs (modifie l'ADR 0009, point 5)** : le texte de l'avis est lu **en mémoire**, pour cette ligne
   seulement. Rien d'autre n'en est gardé, journalisé ni écrit dans l'e-mail ; un avis illisible est journalisé avec le
   message de PDF.js (structure du fichier), jamais son texte.
4. **Lecture du PDF** : `pdfjs-dist` (PDF.js de Mozilla, version figée 6.4.299), texte seulement : pas de police chargée
   (`disableFontFace`), pas de formulaire XFA, 40 pages au plus ; PDF.js 6 n'évalue plus de code. Le fichier vient
   seulement de `www.boamp.fr` ou `ted.europa.eu` (ADR 0009), 5 Mo au plus.
5. **Un avis illisible n'empêche pas l'envoi** : l'offre part sans date limite, avec son PDF, et le récapitulatif le
   signale (« … dont l'avis PDF n'a pas pu être lu »). Un avis lisible sans ligne de date reconnue aussi (« … envoyé(s)
   sans date limite : ni les données de la source ni l'avis PDF n'en donnent ») : un libellé changé au BOAMP ou à TED se
   voit ainsi au premier passage (des petits avis MAPA n'ont réellement pas de date : rien à corriger).

## Conséquences

- Les avis européens échus ne partent plus vers la boîte AO ; les autres partent avec « Date limite de réponse ».
- Un téléchargement d'avis PDF de plus par passage pour un avis qui se révèle échu (il n'était pas téléchargé avant) :
  un par avis, retenu ensuite comme traité.
- Nouvelle dépendance `pdfjs-dist` (environ 37 Mo installés, plus la dépendance facultative `@napi-rs/canvas`, inutile
  ici) ; elle demande Node 22.13 ou plus (`engines`).
- Si le BOAMP ou TED changent le libellé de la ligne, la lecture du PDF ne trouve plus rien : le récapitulatif le
  signale (point 5), adapter `DEADLINE_LINE` (`src/tenders/notice-deadline.ts`) et son test.
- Une à deux requêtes de plus au BOAMP par passage (rectificatifs des avis nouveaux).
- Les e-mails déjà reçus par MyBestConsultant sans date limite se complètent par son script `npm run ao:deadlines`
  (relit les données du BOAMP, écrit seulement la date limite).
