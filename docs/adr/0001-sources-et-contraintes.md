# 0001 — Sources lues et contraintes d'usage

Date : 22 octobre 2026 · Statut : acceptée

## Contexte

Wise Associates veut être prévenue chaque jour des nouveaux appels d'offres et des nouvelles offres d'emploi de
14 organismes : DGFiP, DINUM, INSEE, ASP, APE, Urssaf Caisse nationale (ACOSS), CNAM, La Banque Postale, SFIL, CRH,
Cour des comptes, Autorité de la concurrence, Proparco, Expertise France. Le périmètre des appels d'offres inclut
aussi, à la demande, le réseau régional et départemental de la DGFiP (DRFiP / DDFiP) et l'UCANSS.

Les sources ont été étudiées une à une le 22 octobre 2026 (requêtes réelles, robots.txt, conditions d'utilisation).

## Décision

On lit en priorité les **sources officielles et les flux prévus pour être repris** (API, RSS) ; à défaut, les pages
publiques autorisées par robots.txt, en s'identifiant (User-Agent `veille-marches-emplois`) et sans jamais se faire
passer pour un navigateur ni contourner une protection.

### Appels d'offres

| Source | Accès | Licence / conditions |
|---|---|---|
| BOAMP | API OpenDataSoft de la DILA, sans clé | Licence Ouverte |
| TED (JOUE) | API de recherche v3, sans clé | Réutilisation libre (décision de la Commission du 12/12/2011) |

- Seuls les **avis initiaux** sont retenus : BOAMP `nature = APPEL_OFFRE` **et** `etat = INITIAL` (un rectificatif
  d'avis européen garde `nature = APPEL_OFFRE`) ; TED `form-type = competition` sans version de modification.
- **Reconnaissance de l'acheteur** (`src/organisations.ts`, `src/tenders/buyer-match.ts`) : ni le nom seul (« CNAM »
  = aussi le Conservatoire national des arts et métiers ; 40 Urssaf régionales) ni le SIREN seul (il figure dans les
  avis d'autres acheteurs comme titulaire, comptable ou co-acheteur) ne suffisent. La requête ramène large ; chaque
  avis est vérifié sur ses **vrais acheteurs**. Le SIRET 11000201100044, partagé par plusieurs services de l'État
  (Cour des comptes, APE, Autorité de la concurrence, bureau d'achats de la DGFiP), n'est jamais utilisé.
- La DINUM n'achète pas en son nom : ses marchés passent par les Services du Premier ministre (SPM-DSAF) ; seuls ceux
  qui citent la DINUM sont retenus.
- Un même appel d'offres publié au BOAMP et à TED porte le même identifiant de procédure (`contractfolderid` /
  `procedure-identifier`) : il n'est annoncé qu'une fois.
- Constat : La Banque Postale, SFIL et la CRH ne publient pas d'avis comme acheteurs ; Expertise France et Proparco
  publient à TED seulement.

### Offres d'emploi

| Organismes | Source | Accès |
|---|---|---|
| DGFiP, DINUM, INSEE, ASP, APE, Cour des comptes, Autorité de la concurrence | Choisir le service public | Flux RSS proposé par le site (Talentsoft), textes sous licence Etalab 2.0 |
| Autorité de la concurrence | Site de recrutement (Beetween) | API JSON de la page (offres absentes de Choisir le service public) |
| SFIL | sfil.fr | Flux RSS WordPress |
| Expertise France | Gestmax | Flux RSS officiel |
| Proparco | Site carrières du groupe AFD (Cornerstone) | API JSON de la page, jeton anonyme ; délai de 10 s entre requêtes (robots.txt) |
| La Banque Postale | labanquepostale.com | Pages HTML de la liste d'offres (autorisées par robots.txt) |
| CRH | crh-bonds.com | Lien « La CRH recrute » de la page d'accueil (pas de site carrières) |

## Sources écartées

- **PLACE** (marches-publics.gouv.fr) : pas d'API ni de flux ; ses conditions d'utilisation interdisent « toute reprise
  totale ou partielle […] sans l'autorisation expresse et écrite du directeur de la publication ». À la place : un
  compte entreprise PLACE avec alertes e-mail par acheteur, et les liens PLACE présents dans les avis BOAMP / TED.
  Ce que BOAMP et TED ne montrent pas : les marchés sans publicité obligatoire (moins de 60 k€ HT en fournitures et
  services) et ceux à publicité libre publiés sur PLACE seulement.
- **lasecurecrute.fr** (offres d'emploi Urssaf et CNAM) : les mentions légales interdisent toute utilisation autre que
  la consultation individuelle et privée sans autorisation écrite de l'UCANSS. Décision du 22/10/2026 : Urssaf et CNAM
  hors périmètre pour l'emploi (leurs appels d'offres restent suivis).
- **France Travail** (API Offres d'emploi) : aucun filtre par employeur ; utile seulement pour les enquêteurs INSEE.
- Ancien portail Lumesse de La Banque Postale : obsolète et interdit aux robots.

## Conséquences

- Une source peut changer de format à tout moment : une lecture en échec, ou un nombre d'offres qui s'effondre, est
  signalé en tête du récapitulatif (« Sources à vérifier ») plutôt que de passer pour « aucune nouveauté ».
- Les sources sans API (La Banque Postale, CRH) et les API non documentées (Choisir le service public `top=1000`,
  Beetween, Cornerstone) sont les plus fragiles.
- Réintégrer Urssaf / CNAM pour l'emploi demande l'autorisation écrite de l'UCANSS, puis un adaptateur
  `lasecurecrute.fr` (filtre `typesOrganisme=2,28,3`, une requête).
