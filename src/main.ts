// Point d'entrée : `npm run veille` (passage complet) ou `npm run veille:essai` (lecture et affichage seulement).
// Codes de sortie, lus par le workflow GitHub :
//   0 : passage complet ;
//   1 : passage interrompu avant l'enregistrement de l'état (configuration, fichier d'état…) ;
//   3 : état enregistré mais un envoi a échoué : le workflow pousse l'état (les offres envoyées ne repartent pas),
//       puis échoue et ouvre un ticket.
// Une source en échec n'arrête rien : elle est signalée dans le récapitulatif.

import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { PartialDeliveryError, ScanService } from './scan.service.js'

const logger = new Logger('Veille')
const dryRun = process.argv.includes('--dry-run')

function fail(context: string, error: unknown, exitCode: number): void {
  logger.error(`${context} : ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error.stack : undefined)
  process.exitCode = Math.max(Number(process.exitCode ?? 0), exitCode)
}

try {
  const app = await NestFactory.createApplicationContext(AppModule.register({ dryRun }), { abortOnError: false })
  let stateSaved = false
  try {
    await app.get(ScanService).run()
    stateSaved = !dryRun
  } catch (error) {
    stateSaved = error instanceof PartialDeliveryError
    if (stateSaved) fail('Passage terminé, état enregistré, mais envoi incomplet', error, 3)
    else fail('Passage interrompu', error, 1)
  }
  // Fermeture à part (connexion SMTP comprise) : une erreur ici ne doit pas masquer celle du passage. Si l'état a
  // été enregistré, code 3 : il doit quand même être poussé, sinon les offres envoyées repartiraient.
  await app.close().catch((error: unknown) => fail("Fermeture de l'application", error, stateSaved ? 3 : 1))
} catch (error) {
  fail('Démarrage impossible', error, 1)
}
