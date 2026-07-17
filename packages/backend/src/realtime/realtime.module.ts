import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { TreeModule } from '../tree/tree.module';
import { RealtimeService } from './realtime.service';

@Module({
  imports: [
    TreeModule, // provides AclService
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.accessSecret'),
      }),
    }),
  ],
  providers: [RealtimeService],
})
export class RealtimeModule {}
