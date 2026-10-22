// Point d'entrée : `npm run veille` (passage complet) ou `npm run veille:essai` (lecture et affichage seulement).
// Code de sortie 1 si le passage n'a pas abouti (configuration, fichier d'état, envoi de l'e-mail) : le workflow
// échoue alors et ouvre un ticket GitHub. Une source en échec, elle, est signalée dans le récapitulatif.

import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { ScanService } from './scan.service.js'

const logger = new Logger('Veille')
const dryRun = process.argv.includes('--dry-run')

function fail(context: string, error: unknown): void {
  logger.error(`${context} : ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error.stack : undefined)
  process.exitCode = 1
}

try {
  const app = await NestFactory.createApplicationContext(AppModule.register({ dryRun }), { abortOnError: false })
  try {
    await app.get(ScanService).run()
  } catch (error) {
    fail('Passage interrompu', error)
  }
  // Fermeture à part : une erreur ici ne doit pas masquer celle du passage.
  await app.close().catch((error: unknown) => fail("Fermeture de l'application", error))
} catch (error) {
  fail('Démarrage impossible', error)
}
