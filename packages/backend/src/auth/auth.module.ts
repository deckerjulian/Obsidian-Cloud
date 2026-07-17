import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { UsersModule } from '../users/users.module';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthConfigController } from './auth-config.controller';
import { AuthConfigService } from './auth-config.service';
import { TokenService } from './token.service';
import { JwtStrategy } from './jwt.strategy';
import { LocalAuthProvider } from './providers/local.provider';
import { LdapAuthProvider } from './providers/ldap.provider';

@Module({
  imports: [
    UsersModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.accessSecret'),
        signOptions: { expiresIn: config.get<number>('jwt.accessTtl') },
      }),
    }),
  ],
  controllers: [AuthController, AuthConfigController],
  providers: [
    AuthService,
    TokenService,
    AuthConfigService,
    JwtStrategy,
    LocalAuthProvider,
    LdapAuthProvider,
  ],
  exports: [AuthService, TokenService, AuthConfigService],
})
export class AuthModule {}
