// Point d'entrée.
//   node dist/main.js --schedule   conteneur du VPS : reste lancé et fait les passages planifiés (ADR 0010) ;
//   node dist/main.js              un passage complet, puis arrêt (`npm run veille`, passage lancé à la main) ;
//   node dist/main.js --dry-run    essai : lecture et affichage, rien n'est envoyé ni enregistré.
// Codes de sortie d'un passage :
//   0 : passage complet ;
//   1 : passage interrompu avant l'enregistrement de l'état (configuration, fichier d'état…), ou un autre passage
//       était en cours ;
//   3 : état enregistré, mais un envoi ou la lecture de la boîte AO par MyBestConsultant a échoué.
// Une source en échec n'arrête rien : elle est signalée dans le récapitulatif. Un échec prévient aussi l'équipe par
// e-mail (veille-runner.ts).

import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { EXIT_CODES, VeilleRunner } from './run/veille-runner.js'

const logger = new Logger('Veille')
const dryRun = process.argv.includes('--dry-run')
const scheduled = process.argv.includes('--schedule')

function fail(context: string, error: unknown, exitCode: number): void {
  logger.error(`${context} : ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error.stack : undefined)
  process.exitCode = Math.max(Number(process.exitCode ?? 0), exitCode)
}

/** Processus du conteneur : il reste lancé tant que les passages sont planifiés, jusqu'au signal d'arrêt de Docker. */
async function startScheduler(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule.register({ dryRun: false, scheduled: true }), { abortOnError: false })
  // SIGTERM (docker stop, déploiement) : le passage en cours va au bout avant l'arrêt (veille-scheduler.ts).
  app.enableShutdownHooks(['SIGTERM', 'SIGINT'])
}

async function runOnce(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule.register({ dryRun, scheduled: false }), { abortOnError: false })
  const outcome = await app.get(VeilleRunner).run()
  process.exitCode = EXIT_CODES[outcome]
  // Fermeture à part : une erreur ici ne doit pas masquer le résultat du passage. Si l'état a été enregistré, code 3.
  await app.close().catch((error: unknown) => fail("Fermeture de l'application", error, outcome === 'failed' || outcome === 'busy' ? 1 : 3))
}

try {
  if (scheduled && dryRun) throw new Error('--schedule et --dry-run ne vont pas ensemble : un essai se lance seul (node dist/main.js --dry-run).')
  await (scheduled ? startScheduler() : runOnce())
} catch (error) {
  fail('Démarrage impossible', error, 1)
}
