import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { AuthConfigDto, UpdateAuthConfigRequest } from '@oc/shared';
import { PrismaService } from '../prisma/prisma.service';

const AUTH_KEY = 'auth';

interface StoredLdap {
  url?: string;
  bindDn?: string;
  bindCredentials?: string;
  searchBase?: string;
  searchFilter?: string;
  attrEmail?: string;
  attrDisplayName?: string;
  tls?: boolean;
  adminGroup?: string;
}
interface StoredAuth {
  providers?: string[];
  ldap?: StoredLdap;
}

export interface EffectiveLdap {
  url: string;
  bindDn: string;
  bindCredentials: string;
  searchBase: string;
  searchFilter: string;
  attrEmail: string;
  attrDisplayName: string;
  tls: boolean;
  adminGroup: string;
}

/** Runtime auth configuration: DB-backed, falling back to environment defaults. */
@Injectable()
export class AuthConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private async stored(): Promise<StoredAuth> {
    const row = await this.prisma.setting.findUnique({ where: { key: AUTH_KEY } });
    return (row?.value as StoredAuth | undefined) ?? {};
  }

  private envLdap(): EffectiveLdap {
    return {
      url: this.config.get<string>('ldap.url')!,
      bindDn: this.config.get<string>('ldap.bindDn')!,
      bindCredentials: this.config.get<string>('ldap.bindCredentials')!,
      searchBase: this.config.get<string>('ldap.searchBase')!,
      searchFilter: this.config.get<string>('ldap.searchFilter')!,
      attrEmail: this.config.get<string>('ldap.attrEmail')!,
      attrDisplayName: this.config.get<string>('ldap.attrDisplayName')!,
      tls: this.config.get<boolean>('ldap.tls')!,
      adminGroup: this.config.get<string>('ldap.adminGroup')!,
    };
  }

  /** Enabled providers (DB over env); `local` is always kept as a safety net. */
  async getEnabledProviders(): Promise<string[]> {
    const s = await this.stored();
    const providers = s.providers ?? this.config.get<string[]>('auth.providers') ?? ['local'];
    return providers.includes('local') ? providers : ['local', ...providers];
  }

  async getEffectiveLdap(): Promise<EffectiveLdap> {
    const s = (await this.stored()).ldap ?? {};
    const env = this.envLdap();
    return {
      url: s.url ?? env.url,
      bindDn: s.bindDn ?? env.bindDn,
      bindCredentials: s.bindCredentials ?? env.bindCredentials,
      searchBase: s.searchBase ?? env.searchBase,
      searchFilter: s.searchFilter ?? env.searchFilter,
      attrEmail: s.attrEmail ?? env.attrEmail,
      attrDisplayName: s.attrDisplayName ?? env.attrDisplayName,
      tls: s.tls ?? env.tls,
      adminGroup: s.adminGroup ?? env.adminGroup,
    };
  }

  /** Admin-facing view (no secret). */
  async getDto(): Promise<AuthConfigDto> {
    const ldap = await this.getEffectiveLdap();
    return {
      providers: await this.getEnabledProviders(),
      ldap: {
        url: ldap.url,
        bindDn: ldap.bindDn,
        searchBase: ldap.searchBase,
        searchFilter: ldap.searchFilter,
        attrEmail: ldap.attrEmail,
        attrDisplayName: ldap.attrDisplayName,
        tls: ldap.tls,
        adminGroup: ldap.adminGroup,
        bindCredentialsSet: ldap.bindCredentials.length > 0,
      },
    };
  }

  async update(dto: UpdateAuthConfigRequest): Promise<AuthConfigDto> {
    const current = await this.stored();
    const next: StoredAuth = { ...current };
    if (dto.providers) next.providers = dto.providers;
    if (dto.ldap) {
      const ldap: StoredLdap = { ...(current.ldap ?? {}) };
      const f = dto.ldap;
      if (f.url !== undefined) ldap.url = f.url;
      if (f.bindDn !== undefined) ldap.bindDn = f.bindDn;
      if (f.bindCredentials) ldap.bindCredentials = f.bindCredentials; // only when provided
      if (f.searchBase !== undefined) ldap.searchBase = f.searchBase;
      if (f.searchFilter !== undefined) ldap.searchFilter = f.searchFilter;
      if (f.attrEmail !== undefined) ldap.attrEmail = f.attrEmail;
      if (f.attrDisplayName !== undefined) ldap.attrDisplayName = f.attrDisplayName;
      if (f.tls !== undefined) ldap.tls = f.tls;
      if (f.adminGroup !== undefined) ldap.adminGroup = f.adminGroup;
      next.ldap = ldap;
    }
    const value = next as unknown as Prisma.InputJsonValue;
    await this.prisma.setting.upsert({
      where: { key: AUTH_KEY },
      create: { key: AUTH_KEY, value },
      update: { value },
    });
    return this.getDto();
  }
}
