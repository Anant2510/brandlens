import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { AppConfigService } from './config/config.service';
import { GlobalZodValidationPipe } from './common/zod-validation.pipe';
import { AppLogger } from './common/logger.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // The exception filter renders the ApiError shape; Nest's default JSON
    // body would drift from the contract the web client parses.
    abortOnError: false,
  });

  const config = app.get(AppConfigService);
  const logger = await app.resolve(AppLogger);
  logger.setContext('bootstrap');
  app.useLogger(logger);

  app.use(
    helmet({
      // Swagger UI needs inline styles/scripts; the API itself serves no HTML
      // that a CSP would protect, so relaxing it here costs nothing real.
      contentSecurityPolicy: config.isProduction ? undefined : false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.enableCors({
    origin: config.isProduction ? [config.env.WEB_PUBLIC_URL] : true,
    credentials: true,
    exposedHeaders: ['x-correlation-id'],
  });

  // Brand books run to tens of megabytes; the default 100 kB limit would
  // reject the single most important onboarding upload.
  app.use(json({ limit: '25mb' }));
  app.use(urlencoded({ extended: true, limit: '25mb' }));

  // Validation is zod, end to end. Nest's ValidationPipe is deliberately not
  // registered: it needs class-validator, and a second DTO layer alongside the
  // schemas in @brandlens/contracts is exactly how an API and its client drift.
  app.useGlobalPipes(new GlobalZodValidationPipe());

  const swagger = new DocumentBuilder()
    .setTitle('BrandLens API')
    .setDescription(
      'Brand-compliance verification. `POST /v1/checks` takes an asset and a brand and returns structured findings ' +
        'with severities, measured values, thresholds, bounding boxes and citations. Every verdict is backed by an ' +
        'immutable decision trace.',
    )
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'Session JWT or an API key (bl_live_…)' })
    .addTag('checks', 'The wedge: verification as an API')
    .addTag('brands', 'Brands and the ontology they own')
    .addTag('rules', 'Typed, versioned, scoped, cited rules')
    .addTag('rulesets', 'Brand compile — frozen, hashed snapshots')
    .addTag('mcp', 'Model Context Protocol surface for agent loops')
    .build();

  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger), {
    swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha', operationsSorter: 'alpha' },
  });

  // In-flight checks must finish rather than being severed by a deploy.
  app.enableShutdownHooks();

  await app.listen(config.env.API_PORT, config.env.API_HOST);
  Logger.log(
    `BrandLens API listening on http://${config.env.API_HOST}:${config.env.API_PORT} — docs at /docs`,
    'bootstrap',
  );
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error during bootstrap', err);
  process.exit(1);
});
