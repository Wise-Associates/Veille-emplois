// Organismes suivis et règles qui reconnaissent leurs appels d'offres.
//
// Les avis BOAMP et TED ne disent pas « cet avis est de la DGFiP » : il faut reconnaître l'acheteur. Le SIRET de
// l'acheteur est l'indice le plus sûr, mais il manque sur les petits avis (MAPA) et certains services de l'État
// partagent le SIRET 11000201100044 (« Services de l'État pour la facturation électronique ») : il ne doit jamais
// servir. On combine donc SIREN et nom de l'acheteur. Relevés faits sur 24 mois d'avis (octobre 2026), voir
// docs/adr/0001-sources-et-contraintes.md.

export type OrganisationId =
  | 'dgfip'
  | 'dgfip-reseau'
  | 'dinum'
  | 'insee'
  | 'asp'
  | 'ape'
  | 'acoss'
  | 'cnam'
  | 'ucanss'
  | 'banque-postale'
  | 'sfil'
  | 'crh'
  | 'cour-des-comptes'
  | 'autorite-concurrence'
  | 'proparco'
  | 'expertise-france'

/**
 * Une façon de reconnaître l'acheteur d'un avis. Les noms sont des expressions comparées mot à mot, sans accents,
 * majuscules ni ponctuation (« Agence des participations de l'État » s'écrit `agence des participations de l etat`) ;
 * un `*` final accepte la suite du mot (`proparco*` reconnaît « PROPARCO_75 »).
 */
export interface TenderRule {
  /** SIREN (9 chiffres) : un acheteur dont le SIRET commence par l'un d'eux est reconnu, quel que soit son nom. */
  sirens?: string[]
  /** Expressions cherchées dans le nom de l'acheteur. */
  names?: string[]
  /** Expressions qui écartent un acheteur reconnu par son nom (homonymes). */
  excludedNames?: string[]
  /** Le texte de l'avis doit contenir l'une de ces expressions : acheteur qui achète pour plusieurs services. */
  requiredText?: string[]
}

export interface Organisation {
  id: OrganisationId
  name: string
  tenderRules: TenderRule[]
}

// L'ordre compte : un avis reconnu par deux organismes est rattaché au premier (« DGFiP - DRFiP … » à la DGFiP).
export const ORGANISATIONS: readonly Organisation[] = [
  {
    id: 'dgfip',
    name: 'DGFiP',
    tenderRules: [
      {
        sirens: ['130004955'],
        names: ['direction generale des finances publiques', 'direction generale finances publiques', 'dgfip'],
        // Associations du personnel : pas des achats de la DGFiP.
        excludedNames: ['aafip', 'arfip', 'association'],
      },
    ],
  },
  {
    id: 'dgfip-reseau',
    name: 'DGFiP — directions régionales et départementales',
    tenderRules: [
      {
        names: [
          'drfip',
          'ddfip',
          'direction regionale des finances publiques',
          'direction departementale des finances publiques',
        ],
        // Associations du personnel et école : pas des achats du réseau.
        excludedNames: ['aafip', 'arfip', 'association', 'ecole nationale des finances publiques'],
      },
    ],
  },
  {
    id: 'dinum',
    name: 'DINUM',
    tenderRules: [
      { sirens: ['130025265'], names: ['dinum', 'direction interministerielle du numerique'] },
      // La DINUM n'achète pas en son nom : ses marchés passent par les Services du Premier ministre (SPM-DSAF), qui
      // achètent aussi pour d'autres services. Seuls ceux qui la citent sont retenus.
      {
        names: ['services du premier ministre', 'premier ministre', 'spm dsaf', 'dsaf'],
        requiredText: ['dinum', 'direction interministerielle du numerique'],
      },
    ],
  },
  {
    id: 'insee',
    name: 'INSEE',
    tenderRules: [{ sirens: ['120027016'], names: ['insee', 'institut national de la statistique*'] }],
  },
  {
    id: 'asp',
    name: 'ASP (Agence de services et de paiement)',
    tenderRules: [
      {
        sirens: ['130006372'],
        names: [
          'agence de services et de paiement',
          'agence de service et de paiement',
          'agences de services et de paiement',
          'a s p',
        ],
      },
    ],
  },
  {
    id: 'ape',
    name: "APE (Agence des participations de l'État)",
    tenderRules: [{ sirens: ['130004989'], names: ['agence des participations de l etat'] }],
  },
  {
    id: 'acoss',
    name: 'Urssaf Caisse nationale (ACOSS)',
    tenderRules: [
      {
        sirens: ['180035016'],
        // Jamais « urssaf » seul : une quarantaine d'Urssaf régionales achètent en leur nom.
        names: ['acoss', 'urssaf caisse nationale', 'agence centrale des organismes de securite sociale'],
      },
    ],
  },
  {
    id: 'cnam',
    name: "CNAM (Caisse nationale de l'Assurance Maladie)",
    tenderRules: [
      {
        sirens: ['180035024'],
        names: [
          'caisse nationale de l assurance maladie',
          'caisse nationale d assurance maladie',
          'caisse nationale assurance maladie',
          'caisse nationale de l assur maladie',
          'cnam',
        ],
        // « CNAM » désigne aussi le Conservatoire national des arts et métiers.
        excludedNames: ['conservatoire', 'arts et metiers'],
      },
    ],
  },
  {
    id: 'ucanss',
    name: 'UCANSS (achats mutualisés de la Sécurité sociale)',
    tenderRules: [{ sirens: ['784621435'], names: ['ucanss', 'union des caisses nationales de securite sociale'] }],
  },
  {
    id: 'banque-postale',
    name: 'La Banque Postale',
    tenderRules: [{ sirens: ['421100645'], names: ['banque postale'] }],
  },
  {
    id: 'sfil',
    name: 'SFIL',
    // 421318064 : CAFFIL, filiale de refinancement de SFIL.
    tenderRules: [{ sirens: ['428782585', '421318064'], names: ['sfil', 'caffil', 'caisse francaise de financement local'] }],
  },
  {
    id: 'crh',
    name: "CRH (Caisse de Refinancement de l'Habitat)",
    tenderRules: [{ sirens: ['333614980'], names: ['caisse de refinancement de l habitat'] }],
  },
  {
    id: 'cour-des-comptes',
    name: 'Cour des comptes',
    tenderRules: [{ sirens: ['110000288'], names: ['cour des comptes'], excludedNames: ['europeenne'] }],
  },
  {
    id: 'autorite-concurrence',
    name: 'Autorité de la concurrence',
    tenderRules: [{ sirens: ['110000163'], names: ['autorite de la concurrence'] }],
  },
  {
    id: 'proparco',
    name: 'Proparco',
    tenderRules: [{ sirens: ['310792205'], names: ['proparco*'] }],
  },
  {
    id: 'expertise-france',
    name: 'Expertise France',
    tenderRules: [{ sirens: ['808734792'], names: ['expertise france'] }],
  },
]

export function organisationName(id: OrganisationId): string {
  const organisation = ORGANISATIONS.find((o) => o.id === id)
  if (!organisation) throw new Error(`Organisme inconnu : ${id}`)
  return organisation.name
}
