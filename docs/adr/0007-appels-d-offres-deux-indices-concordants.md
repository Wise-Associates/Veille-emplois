# 0007 — Appels d'offres : deux indices concordants

Date : 27 octobre 2026 · Statut : acceptée (remplace la règle des appels d'offres des ADR 0004 et 0006)

## Contexte

Dès les premiers envois de la recherche chez tous les acheteurs (ADR 0006), des avis hors sujet arrivent dans la boîte
AO, par exemple « Prestations d'assistance de gestion documentaire » de l'ASNR, classé « services d'introduction de
données » (CPV 72312000). Demande du 27/10/2026 : être sûr de chaque critère, n'envoyer aucun avis hors sujet.

Mesure du 27/10/2026 sur les avis ouverts, avec la règle de l'ADR 0006 :

- autres acheteurs, 392 avis gardés :
  - 242 par la seule classification : licences, imprimantes, réactifs, billetterie, accès à Internet, infogérance,
    saisie de données… et une minorité de vrais projets SI ;
  - 32 par un mot-clé de la description seulement : portiers de rue, veille presse, parcs relais… ;
  - 118 par un mot-clé de l'intitulé, hors sujet surtout quand l'avis est classé hors informatique : stand,
    formation, agence de voyages, télescope « ELT », système de pesée ;
- organismes suivis : 5 avis, tous hors sujet. Les imprimantes de la Cnam passaient grâce à un code CPV secondaire
  48820000, sixième de la liste, et des matériels de cuisine grâce à « maintenance corrective ».

Trois causes : un code CPV secondaire suffisait ; la description contient des mots génériques ; un seul indice
(classification ou mot-clé) suffisait.

## Décision

Un appel d'offres n'est envoyé que si **deux indices concordent** (`isItTender`, `src/it-scope.ts`) :

1. **Classification.** Le code CPV **principal** de l'avis commence par 72 ou 48 :
   - TED : `main-classification-proc` ;
   - BOAMP eForms : `MainCommodityClassification` de la procédure ;
   - BOAMP, formulaire national : `objetPrincipal`.

   Sans code CPV (petits avis du BOAMP), un descripteur informatique du BOAMP en tient lieu. Les codes secondaires
   et ceux des lots ne sont pas lus.
2. **Intitulé.** Il contient un mot-clé des appels d'offres. Pour un organisme suivi, le vocabulaire du filtre
   informatique compte aussi. La description n'est plus lue.

Cas particuliers :
- un avis classé hors informatique est écarté, même avec un mot-clé ;
- sans aucune classification, seul un avis d'organisme suivi peut passer, sur son intitulé ;
- les exclusions (« travaux ») et l'« infrastructure seule » sont inchangées.

Au BOAMP, la recherche chez tous les acheteurs n'a plus de requête par descripteurs : un avis doit avoir un mot-clé
dans son intitulé, donc les requêtes par famille suffisent. Seuls les avis dont l'intitulé contient exactement un
mot-clé sont relus en entier. Le format des réglages ne change pas.

## Conséquences

- **Mesure du 27/10/2026 avec cette règle : 74 appels d'offres distincts**, soit 109 avis BOAMP et TED (un même
  appel d'offres peut être publié aux deux). Ce sont des logiciels, de la TMA, des SI, du SaaS, des données et de l'IA.
  Aucun chez les organismes suivis.
- **Moins de vrais projets.** Un avis informatique d'un autre acheteur n'est plus envoyé si son intitulé ne contient
  aucun mot-clé (« Mise en place d'un système d'information… », « Conseil au pilotage de la DSI », « Acquisition
  d'un ERP et d'un CRM »). Un projet de conseil classé CPV 79 ne l'est plus non plus, même avec un mot-clé. Pour les
  rattraper : ajouter le terme à une famille (admin, onglet « Mots-clés »), après mesure (`npm run veille:essai`).
- « logiciel* » seul fait entrer les achats de licences (Microsoft, Autodesk, SAP) : le retirer si ces achats ne
  sont pas voulus.
- Les sigles de deux lettres (« IA », « BI ») fonctionnent aussi dans TED : la requête par CPV ramène tous les avis
  classés informatique.
- Les avis hors sujet déjà envoyés restent dans MyBestConsultant, où un administrateur peut les ignorer. Un avis
  écarté reste retenu comme vu (ADR 0004).
