# 0006 — Appels d'offres de tous les acheteurs, par mots-clés

Date : 27 octobre 2026 · Statut : acceptée (étend les ADR 0004 et 0005)

## Contexte

La veille ne cherchait les appels d'offres que chez les organismes suivis (16 en octobre 2026), reconnus par leur
SIREN ou leur nom d'acheteur. Wise Associates veut toutes les consultations publiques sur le développement d'outils
SaaS, la digitalisation, les données, l'IA et les projets informatiques, quel que soit l'acheteur. La liste de mots-clés
de départ a été préparée avec ChatGPT : 10 familles (SaaS et logiciels, développement, refonte et TMA, digitalisation,
gouvernance des données, plateformes de données, BI, IA, conseil SI / AMOA, outils de risques et de conformité) et une
liste « infrastructure seule » (serveurs, réseau, matériel).

Choix du 27/10/2026 : tous les acheteurs (BOAMP et TED) ; dans les familles « conseil » et « risques », seulement les
termes liés aux outils et au SI ; au premier passage, tous les avis encore ouverts (120 jours de publication).

## Décision

1. **Réglages `tenderKeywords`** (même format dans MyBestConsultant, `schemaVersion` inchangé) : interrupteur « tous
   les acheteurs », familles de mots-clés (expressions et sigles en majuscules) et expressions « infrastructure
   seule ». Absents des réglages enregistrés avant : recherche limitée aux organismes suivis, sans mot-clé.
2. **Règle d'un appel d'offres** (`isItTender`, `src/it-scope.ts`), pour tous les avis, organismes suivis compris :
   - un mot-clé dans l'intitulé ou la description l'emporte sur la classification (un projet de digitalisation est
     souvent classé « conseil », CPV 79) ; les exclusions (« travaux »…) ne sont cherchées que dans l'intitulé ;
   - sinon, un avis classé informatique (CPV 72 / 48, descripteurs BOAMP) est gardé, sauf si son intitulé relève de
     l'« infrastructure seule » ;
   - sinon, comme avant : classé hors informatique, écarté ; sans classification, jugé sur son intitulé.
3. **Recherche sur l'intitulé** (`src/tenders/all-buyers.ts`) : au BOAMP, une requête par famille (`search(objet, …)`)
   et une par descripteurs informatiques ; dans TED, une par famille (`title-proc~`) et une par CPV. Le texte complet
   ne s'y prête pas : « dématérialisation » et « signature électronique » figurent dans les modalités de dépôt de
   presque tous les avis (4 333 avis ouverts pour la seule famille « digitalisation »). Les deux recherches ignorent
   l'ordre des mots et les mots d'une lettre : chaque avis renvoyé est revérifié sur les expressions exactes, et ceux
   qui ne correspondent pas sont laissés de côté sans être retenus comme vus. Dans TED, un terme seul de moins de trois
   lettres (« IA », « BI ») renverrait tous les avis : il n'y est pas cherché.
4. **BOAMP en deux temps** : liste sans le contenu des avis (`select`), puis contenu complet (`idweb IN (…)`, 50 par
   requête) des seuls avis encore inconnus de la veille. Environ 400 avis ouverts sont relus à chaque passage ; le
   contenu (14 Ko en moyenne) n'est lu qu'une fois. La présélection sur la liste ne tient pas compte de
   l'« infrastructure seule » : un mot-clé peut être dans la description, jugée sur l'avis complet.
5. **Sources à part** : « BOAMP — tous les acheteurs » (`boamp-tous-acheteurs`) et « TED — tous les acheteurs »
   (`ted-tous-acheteurs`), lues après les sources BOAMP et TED des organismes suivis, quand celles-ci sont activées et
   la recherche aussi. Chacune a sa clé dans le fichier d'état : une famille trop large qui la fait échouer (erreur
   nommant la famille) n'arrête pas la lecture des organismes suivis, et l'alerte « aucun avis depuis trois semaines »
   de ceux-ci n'est pas masquée par les centaines d'avis des autres acheteurs. Elles ne gardent que les avis d'acheteurs
   non suivis : ceux d'un organisme suivi restent à sa source (pas de doublon).
6. **« Autres acheteurs »** : ces avis sont rattachés à un organisme réservé (`OTHER_BUYERS_ID`, placé après les
   organismes suivis : envoyé et présenté en dernier) ; leur acheteur devient le « Client » de l'e-mail.

## Conséquences

- Mesure du 27/10/2026 (essai réel) : 230 avis du BOAMP et 163 de TED retenus, soit 435 nouvelles annonces avec les
  offres d'emploi au premier passage (3 passages à 200 au plus). Les deux sources « tous les acheteurs » étant
  nouvelles dans le fichier d'état, leur premier passage envoie tous les avis encore ouverts (choix du 27/10/2026).
- Un mot-clé très court ou courant (« des », « pour », sigle « AND ») fait renvoyer des milliers d'avis : la source
  « tous les acheteurs » échoue en nommant la famille, signalée dans le récapitulatif ; le corriger dans l'admin. Ensuite, quelques dizaines d'avis par jour : chacun
  coûte un e-mail et une lecture par l'IA de MyBestConsultant.
- Termes de la liste de départ écartés après mesure sur les vrais avis : « assistance à maîtrise d'ouvrage » seul
  (116 avis ouverts, presque tous du bâtiment), « refonte » seul (refonte graphique, modèle de transport : seulement
  ses formes informatiques, « refonte du site », « refonte applicative »…), « reporting », « gestion des risques »,
  « contrôle interne », « audit interne », « compliance », « bases de données » (formations, abonnements
  documentaires). « AMOA » reste : il ramène aussi quelques avis du bâtiment. Liste « infrastructure seule » complétée
  par « maintenance des serveurs », « pylône », « mât d'antenne », « antenne relais » (pas « antenne » seul : antenne
  régionale).
- Un avis écarté reste retenu comme vu (ADR 0004) : élargir les mots-clés ne renvoie pas les avis déjà écartés.
- Les sigles de deux lettres ne trouvent dans TED que les avis classés en CPV 72 / 48.
- Les profils d'acheteur ne sont pas lus : leurs conditions d'utilisation interdisent la reprise des annonces sans
  accord écrit (PLACE, marches-publics.info d'AW Solutions) ou restent à vérifier (Maximilien, où publie l'UGAP). Leurs
  marchés au-dessus des seuils européens sont aussi au BOAMP et dans TED ; les petits marchés publiés seulement sur un
  profil d'acheteur manquent.
