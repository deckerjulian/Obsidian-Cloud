import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { DEV_ACCESS_SECRET, DEV_REFRESH_SECRET, DEV_BOOTSTRAP_PASSWORD } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');
  const isProduction = config.get<string>('nodeEnv') === 'production';

  // The dev fallback secrets are in the public repo: with them, anyone can
  // forge an admin access token. Refuse to serve production traffic that way.
  if (isProduction) {
    const insecure: string[] = [];
    if (config.get<string>('jwt.accessSecret') === DEV_ACCESS_SECRET) insecure.push('JWT_ACCESS_SECRET');
    if (config.get<string>('jwt.refreshSecret') === DEV_REFRESH_SECRET) insecure.push('JWT_REFRESH_SECRET');
    if (insecure.length > 0) {
      throw new Error(
        `Refusing to start in production with default ${insecure.join(' and ')}. ` +
          'Set strong values in .env (e.g. `openssl rand -base64 48`).',
      );
    }
    if (config.get<string>('bootstrap.adminPassword') === DEV_BOOTSTRAP_PASSWORD) {
      logger.warn(
        'BOOTSTRAP_ADMIN_PASSWORD is still the default — change the admin password immediately.',
      );
    }
  }

  // Behind the reverse proxy (Caddy in docker-compose) the client IP must come
  // from X-Forwarded-For — otherwise every user shares one rate-limit bucket.
  // Only enable when the app is NOT directly reachable (header spoofing).
  if (config.get<boolean>('trustProxy')) {
    app.set('trust proxy', 1);
  }

  // Allow base64 blob uploads up to MAX_BLOB_BYTES (32 MB) plus base64+JSON
  // overhead for attachments.
  app.useBodyParser('json', { limit: '64mb' });

  // All REST routes live under /api/*. The Yjs WebSocket is mounted separately.
  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const publicUrl = config.get<string>('publicUrl')!;
  // Obsidian desktop/mobile plugin origins are always allowed; arbitrary
  // localhost ports (Vite dev server etc.) only outside production.
  const origins: (string | RegExp)[] = [publicUrl, /^app:\/\/obsidian\.md$/, /^capacitor:\/\/localhost$/];
  if (!isProduction) origins.push(/^http:\/\/localhost:\d+$/);
  // Expose ETag so a cross-origin web app (separate VITE_API_BASE) can read it
  // for the conditional tree poll. Same-origin (Caddy) doesn't need this.
  app.enableCors({ origin: origins, credentials: true, exposedHeaders: ['ETag'] });

  const port = config.get<number>('port')!;
  await app.listen(port);
  logger.log(`REST API listening on http://localhost:${port}/api`);
}

void bootstrap();
