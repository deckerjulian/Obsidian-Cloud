import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsOptional, IsString, ValidateNested } from 'class-validator';
import type { UpdateAuthConfigRequest } from '@oc/shared';

class LdapUpdateDto {
  @IsOptional() @IsString() url?: string;
  @IsOptional() @IsString() bindDn?: string;
  @IsOptional() @IsString() bindCredentials?: string;
  @IsOptional() @IsString() searchBase?: string;
  @IsOptional() @IsString() searchFilter?: string;
  @IsOptional() @IsString() attrEmail?: string;
  @IsOptional() @IsString() attrDisplayName?: string;
  @IsOptional() @IsBoolean() tls?: boolean;
  @IsOptional() @IsString() adminGroup?: string;
}

export class UpdateAuthConfigDto implements UpdateAuthConfigRequest {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  providers?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => LdapUpdateDto)
  ldap?: LdapUpdateDto;
}
