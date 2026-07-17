import { IsOptional, IsString, MinLength } from 'class-validator';
import type { UploadBlobRequest } from '@oc/shared';

export class UploadBlobDto implements UploadBlobRequest {
  @IsString()
  @MinLength(1)
  contentBase64!: string;

  @IsOptional()
  @IsString()
  mime?: string;
}
