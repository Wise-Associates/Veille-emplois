// Réglages du dépôt (config/defaults.json) : ceux chargés une première fois dans MyBestConsultant (npm run veille:seed de
// MyBestConsultant), ceux des tests, et le dernier recours d'un passage sans réglages lisibles (veille-settings.ts).
// Un fichier invalide arrête la veille dès le démarrage.

import { readFileSync } from 'node:fs'
import { parseVeilleSettings, type VeilleSettings } from './veille-settings.js'

// Depuis dist/settings/ ou dist-test/settings/ : le fichier est à la racine du projet.
const FILE = new URL('../../config/defaults.json', import.meta.url)

function load(): VeilleSettings {
  const parsed = parseVeilleSettings(JSON.parse(readFileSync(FILE, 'utf8')))
  if (!parsed.success) throw new Error(`config/defaults.json invalide — ${parsed.error}`)
  return parsed.settings
}

export const DEFAULT_SETTINGS: VeilleSettings = load()
