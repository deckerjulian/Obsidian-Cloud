import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { AuthResponse } from '@oc/shared';
import { UsersService, toUserDto } from '../users/users.service';
import { TokenService } from './token.service';
import type { AuthProvider, ExternalIdentity } from './providers/auth-provider.interface';
import { LocalAuthProvider } from './providers/local.provider';
import { LdapAuthProvider } from './providers/ldap.provider';
import { AuthConfigService } from './auth-config.service';
import type { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly registry: Record<string, AuthProvider>;

  constructor(
    local: LocalAuthProvider,
    ldap: LdapAuthProvider,
    private readonly authConfig: AuthConfigService,
    private readonly users: UsersService,
    private readonly tokens: TokenService,
  ) {
    this.registry = { local, ldap };
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    const enabled = await this.authConfig.getEnabledProviders();
    const order = dto.provider ? [dto.provider] : enabled;
    const candidates = order
      .map((name) => this.registry[name])
      .filter((p): p is AuthProvider => Boolean(p));

    for (const provider of candidates) {
      let identity: ExternalIdentity | null = null;
      try {
        identity = await provider.authenticate(dto.username, dto.password);
      } catch (err) {
        // Infrastructure error (e.g. directory unreachable) — try the next provider.
        this.logger.warn(`Provider '${provider.name}' failed: ${(err as Error).message}`);
        continue;
      }
      if (identity) {
        const user = await this.users.upsertFromIdentity(identity);
        const tokens = await this.tokens.issue(user);
        return { user: toUserDto(user), tokens };
      }
    }

    throw new UnauthorizedException('Invalid credentials');
  }

  async refresh(refreshToken: string): Promise<AuthResponse> {
    const { user, tokens } = await this.tokens.rotate(refreshToken);
    return { user: toUserDto(user), tokens };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokens.revoke(refreshToken);
  }
}
