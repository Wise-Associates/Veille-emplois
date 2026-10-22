/** Horloge injectée : les tests fixent la date du passage. */
export const CLOCK = Symbol('CLOCK')

export interface Clock {
  now(): Date
}
