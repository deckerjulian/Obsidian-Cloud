import { IsBoolean, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import type { CreateUserRequest } from '@oc/shared';

export class CreateUserDto implements CreateUserRequest {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  displayName!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsOptional()
  @IsBoolean()
  isAdmin?: boolean;
}
