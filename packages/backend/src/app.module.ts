import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { HealthController } from './health/health.controller';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { TreeModule } from './tree/tree.module';
import { DocumentsModule } from './documents/documents.module';
import { RealtimeModule } from './realtime/realtime.module';
import { E2eeModule } from './e2ee/e2ee.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    // Global rate limit: 600 requests/minute per IP (auth routes are stricter).
    // Generous for authenticated API traffic (a note with many attachments, a
    // vault import); login has its own strict limit (auth.controller).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 600 }]),
    PrismaModule,
    UsersModule,
    AuthModule,
    TreeModule,
    DocumentsModule,
    RealtimeModule,
    E2eeModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
