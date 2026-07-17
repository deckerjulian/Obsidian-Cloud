import { IsString, MinLength } from 'class-validator';
import type { ChangePasswordRequest } from '@oc/shared';

export class ChangePasswordDto implements ChangePasswordRequest {
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @IsString()
  @MinLength(8)
  newPassword!: string;
}
