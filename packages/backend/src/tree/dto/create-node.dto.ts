import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';
import type { NodeKind, CreateNodeRequest, SystemFolderType } from '@oc/shared';

export class CreateNodeDto implements CreateNodeRequest {
  // Required: null = vault root, otherwise a parent folder id.
  @ValidateIf((o: CreateNodeDto) => o.parentId !== null)
  @IsUUID()
  parentId!: string | null;

  @IsIn(['folder', 'file'])
  kind!: NodeKind;

  // The name is E2EE ciphertext (12-byte IV + AES-GCM tag, base64), not the
  // plaintext: a 255-char UTF-8 filename encrypts to ~1.4 kB of base64.
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  name!: string;

  @IsOptional()
  @IsBoolean()
  isText?: boolean;

  @IsOptional()
  @IsString()
  mime?: string;

  @IsOptional()
  @IsIn(['plugins'])
  systemType?: SystemFolderType;
}
