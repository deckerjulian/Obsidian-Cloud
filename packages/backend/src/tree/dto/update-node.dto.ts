import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { UpdateNodeRequest } from '@oc/shared';

export class UpdateNodeDto implements UpdateNodeRequest {
  // Ciphertext, not plaintext — see CreateNodeDto.name.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  name?: string;

  // Optional. Present + null = move to root; present + uuid = move under that folder.
  @IsOptional()
  @IsUUID()
  parentId?: string | null;
}
