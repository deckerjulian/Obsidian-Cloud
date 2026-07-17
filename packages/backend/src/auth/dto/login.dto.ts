import { IsOptional, IsString, MinLength } from 'class-validator';
import type { LoginRequest } from '@oc/shared';

export class LoginDto implements LoginRequest {
  @IsString()
  @MinLength(1)
  username!: string;

  @IsString()
  @MinLength(1)
  password!: string;

  @IsOptional()
  @IsString()
  provider?: string;
}
