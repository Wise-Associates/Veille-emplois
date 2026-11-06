import { setTimeout as sleep } from 'node:timers/promises'
import { Module, type DynamicModule } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { CLOCK, type Clock } from './clock.js'
import { APP_CONFIG, loadConfig } from './config.js'
import { HttpClient } from './http/http-client.js'
import { Mailer } from './mail/mailer.js'
import { AoInboxSync, SLEEP, type Sleep } from './run/ao-inbox-sync.js'
import { VeilleRunner } from './run/veille-runner.js'
import { VeilleScheduler } from './run/veille-scheduler.js'
import { ScanService } from './scan.service.js'
import { SettingsLoader } from './settings/settings-loader.js'
import { createSources, SOURCE_FACTORY, type SourceFactory } from './sources/sources.js'
import { StateStore } from './state/state-store.js'
import { NoticePdfReader } from './tenders/notice-pdf.js'

export interface RunOptions {
  dryRun: boolean
  /** Conteneur du VPS : le processus reste lancé et fait les passages planifiés (veille-scheduler.ts, ADR 0010). */
  scheduled: boolean
}

/**
 * Application sans serveur HTTP (contexte d'application autonome de Nest, voir main.ts) : un passage puis arrêt, ou,
 * sur le VPS, des passages planifiés dans un processus qui reste lancé.
 */
@Module({})
export class AppModule {
  static register(options: RunOptions): DynamicModule {
    return {
      module: AppModule,
      imports: options.scheduled ? [ScheduleModule.forRoot()] : [],
      providers: [
        { provide: APP_CONFIG, useFactory: () => loadConfig(process.env, options.dryRun) },
        { provide: CLOCK, useValue: { now: () => new Date() } satisfies Clock },
        { provide: SLEEP, useValue: ((ms: number) => sleep(ms)) satisfies Sleep },
        HttpClient,
        {
          provide: SOURCE_FACTORY,
          useFactory: (http: HttpClient, clock: Clock): SourceFactory => (settings, organisations) => createSources(http, clock, settings, organisations),
          inject: [HttpClient, CLOCK],
        },
        SettingsLoader,
        StateStore,
        Mailer,
        NoticePdfReader,
        ScanService,
        AoInboxSync,
        VeilleRunner,
        ...(options.scheduled ? [VeilleScheduler] : []),
      ],
    }
  }
}
