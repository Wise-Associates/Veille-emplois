import type { OrganisationId } from './organisations.js'

export type ListingKind = 'tender' | 'job'

/** Une annonce, quelle que soit sa source : un appel d'offres ou une offre d'emploi, telle qu'affichée dans le récapitulatif. */
export interface Listing {
  kind: ListingKind
  /** Identifiant stable dans sa source (numéro d'avis, référence d'offre) : c'est lui qui repère les nouveautés. */
  id: string
  organisationId: OrganisationId
  title: string
  url: string
  /** Date de publication (AAAA-MM-JJ), quand la source en donne une fiable. */
  publishedOn?: string
  /** Date limite de réponse ou de candidature : AAAA-MM-JJ, ou date-heure ISO quand la source donne l'heure. */
  deadline?: string
  location?: string
  /** Précisions courtes affichées sous le titre (acheteur exact, type de marché, contrat…). */
  details: string[]
  /** Identifiant de procédure commun à BOAMP et TED : le même appel d'offres n'est annoncé qu'une fois. */
  procedureId?: string
}

/** Ce qu'une source a lu lors d'un passage. */
export interface SourceBatch {
  listings: Listing[]
  /**
   * Annonces lues mais hors périmètre (ex. offres AFD qui ne sont pas de Proparco) : retenues comme « déjà vues »
   * pour ne pas les réexaminer à chaque passage, jamais annoncées.
   */
  ignoredIds: string[]
  /** Lecture réussie mais partiellement douteuse (ex. avis au contenu illisible) : affiché dans « Sources à vérifier ». */
  warnings?: string[]
}

/** Ce qu'une source sait de son passage précédent, pour ne faire les appels coûteux que sur les annonces inconnues. */
export interface SourceContext {
  /** Première lecture de la source : tout ce qu'elle renvoie est enregistré sans être annoncé. */
  firstRun: boolean
  isKnown(id: string): boolean
}

export interface ListingSource {
  /** Clé de la source dans le fichier d'état : ne jamais la renommer, sinon la source repart de zéro. */
  readonly id: string
  /** Nom lisible, affiché dans le récapitulatif en cas de problème. */
  readonly label: string
  /**
   * `job` : la source renvoie toutes ses offres en ligne (un effondrement du nombre est suspect) ; `tender` : les
   * avis des derniers jours seulement.
   */
  readonly kind: ListingKind
  fetch(context: SourceContext): Promise<SourceBatch>
}
