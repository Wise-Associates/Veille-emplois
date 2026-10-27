import { Module, type DynamicModule } from '@nestjs/common'
import { CLOCK, type Clock } from './clock.js'
import { APP_CONFIG, loadConfig } from './config.js'
import { HttpClient } from './http/http-client.js'
import { Mailer } from './mail/mailer.js'
import { ScanService } from './scan.service.js'
import { SettingsLoader } from './settings/settings-loader.js'
import { createSources, SOURCE_FACTORY, type SourceFactory } from './sources/sources.js'
import { StateStore } from './state/state-store.js'

export interface RunOptions {
  dryRun: boolean
}

/**
 * Application sans serveur HTTP : le workflow GitHub la lance une fois par jour, elle fait un passage et s'arrête
 * (contexte d'application autonome de Nest, voir main.ts).
 */
@Module({})
export class AppModule {
  static register(options: RunOptions): DynamicModule {
    return {
      module: AppModule,
      providers: [
        { provide: APP_CONFIG, useFactory: () => loadConfig(process.env, options.dryRun) },
        { provide: CLOCK, useValue: { now: () => new Date() } satisfies Clock },
        HttpClient,
        {
          provide: SOURCE_FACTORY,
          useFactory: (http: HttpClient, clock: Clock): SourceFactory => (settings, organisations) => createSources(http, clock, settings, organisations),
          inject: [HttpClient, CLOCK],
        },
        SettingsLoader,
        StateStore,
        Mailer,
        ScanService,
      ],
    }
  }
}
