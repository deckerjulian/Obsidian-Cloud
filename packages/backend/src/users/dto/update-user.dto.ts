import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';
import type { UpdateUserRequest } from '@oc/shared';

export class UpdateUserDto implements UpdateUserRequest {
  @IsOptional()
  @IsString()
  @MinLength(1)
  displayName?: string;

  @IsOptional()
  @IsBoolean()
  isAdmin?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;
}
