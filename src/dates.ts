// Dates de la veille, toujours exprimées à l'heure de Paris : le passage a lieu tôt le matin (UTC), et une date UTC
// donnerait parfois la veille.

const PARIS = 'Europe/Paris'

/** Jour à Paris au format AAAA-MM-JJ. */
export function parisDay(instant: Date): string {
  // Le format canadien (fr-CA) est précisément AAAA-MM-JJ.
  return new Intl.DateTimeFormat('fr-CA', { timeZone: PARIS, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant)
}

/** Ajoute (ou retire) des jours à une date AAAA-MM-JJ. */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** « 22/10/2026 » à partir de AAAA-MM-JJ. */
export function frenchDay(day: string): string {
  const [year, month, date] = day.split('-')
  return `${date}/${month}/${year}`
}

/**
 * Date limite lisible : « 19/11/2026 » pour une date seule, « 19/11/2026 à 13:00 » quand la source donne l'heure
 * (convertie à l'heure de Paris).
 */
export function frenchDeadline(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return frenchDay(value)
  const instant = new Date(value)
  if (Number.isNaN(instant.getTime())) return value
  const time = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, hour: '2-digit', minute: '2-digit' }).format(instant)
  return `${frenchDay(parisDay(instant))} à ${time}`
}

/**
 * Date-heure ISO d'une heure de Paris (« 2026-11-30 », « 12:00 » → « 2026-11-30T12:00:00+01:00 »), heure d'été comprise.
 * Heure inexistante (passage à l'heure d'été) : décalage d'hiver.
 */
export function parisLocalIso(day: string, time: string): string {
  for (const offset of ['+01:00', '+02:00']) {
    const iso = `${day}T${time}:00${offset}`
    const instant = new Date(iso)
    const local = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, hour: '2-digit', minute: '2-digit' }).format(instant)
    if (parisDay(instant) === day && local === time) return iso
  }
  return `${day}T${time}:00+01:00`
}

/**
 * Date limite à retenir parmi celles d'un avis (lots, demandes de participation et offres), au jour `today` (AAAA-MM-JJ,
 * Paris) : la plus proche encore à venir ; toutes passées, la plus tardive (l'avis est clos). Un avis dont un lot reste
 * ouvert n'est donc jamais écarté comme échu (écart définitif : l'avis est retenu comme traité). Comparaison sur le jour
 * écrit, comme le contrôle des offres échues de scan.service.ts. `today` vide : la plus proche (affichage seul).
 */
export function pickDeadline(values: readonly string[], today: string): string | undefined {
  const dated = values
    .map((value) => ({ value, at: new Date(value.length === 10 ? `${value}T00:00:00Z` : value).getTime() }))
    .filter(({ at }) => !Number.isNaN(at))
    .sort((a, b) => a.at - b.at)
  return (dated.find(({ value }) => value.slice(0, 10) >= today) ?? dated.at(-1))?.value
}

/** AAAA-MM-JJ depuis une date de flux RSS (« Thu, 22 Oct 2026 14:05:32 +0200 »), ou undefined si illisible. */
export function dayFromRssDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const instant = new Date(value)
  return Number.isNaN(instant.getTime()) ? undefined : parisDay(instant)
}

/** AAAA-MM-JJ depuis « 21/10/2026 », ou undefined si le format ne correspond pas. */
export function dayFromFrenchDate(value: string | undefined): string | undefined {
  const match = value?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  return match ? `${match[3]}-${match[2]}-${match[1]}` : undefined
}
