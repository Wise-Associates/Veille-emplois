import type { OrganisationId } from './organisations.js'

export type ListingKind = 'tender' | 'job'

/**
 * Une annonce, quelle que soit sa source : un appel d'offres ou une offre d'emploi. Chacune part dans son propre
 * e-mail vers la boîte AO de MyBestConsultant, et figure en une ligne dans le récapitulatif de l'équipe.
 */
export interface Listing {
  kind: ListingKind
  /** Identifiant stable dans sa source (numéro d'avis, référence d'offre) : c'est lui qui repère les nouveautés. */
  id: string
  organisationId: OrganisationId
  /**
   * Nom de l'acheteur d'un appel d'offres hors organismes suivis (`OTHER_BUYERS_ID`, recherche chez tous les acheteurs) :
   * il remplace le nom de l'organisme comme client dans l'e-mail.
   */
  buyer?: string
  title: string
  url: string
  /** Date de publication (AAAA-MM-JJ), quand la source en donne une fiable. */
  publishedOn?: string
  /** Date limite de réponse ou de candidature : AAAA-MM-JJ, ou date-heure ISO quand la source donne l'heure. */
  deadline?: string
  location?: string
  /** Précisions courtes (acheteur ou employeur exact, type de marché, contrat…). */
  details: string[]
  /** Texte complet de l'annonce (missions, profil, lots…), en texte brut. */
  description?: string
  /** Identifiant de procédure commun à BOAMP et TED : le même appel d'offres n'est annoncé qu'une fois. */
  procedureId?: string
  /** Codes CPV d'un appel d'offres (classification européenne), pour le périmètre informatique (it-scope.ts). */
  cpv?: string[]
  /** Descripteurs du BOAMP (« Logiciel », « Informatique (prestations de services) »…), pour le même usage. */
  descriptors?: string[]
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
  isKnown(id: string): boolean
}

/** Compléments lus sur la page d'une offre, qui remplacent ou complètent ceux de la liste. */
export type ListingDetails = Partial<Pick<Listing, 'description' | 'deadline' | 'location' | 'publishedOn' | 'details'>>

export interface ListingSource {
  /** Clé de la source dans le fichier d'état : ne jamais la renommer, sinon toutes ses offres seraient renvoyées. */
  readonly id: string
  /** Nom lisible, affiché dans le récapitulatif en cas de problème. */
  readonly label: string
  /**
   * `job` : la source renvoie toutes ses offres en ligne (un effondrement du nombre est suspect) ; `tender` : les
   * avis des derniers jours seulement.
   */
  readonly kind: ListingKind
  fetch(context: SourceContext): Promise<SourceBatch>
  /**
   * Pour les sources dont la liste ne donne pas tout (description, date limite) : lecture de la page d'une offre,
   * faite seulement au moment de l'envoyer.
   */
  describe?(listing: Listing): Promise<ListingDetails>
}
