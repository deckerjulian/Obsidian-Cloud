import { ArrayMaxSize, IsArray, IsBase64, IsISO8601, IsOptional, IsString, IsUUID } from 'class-validator';
import { MAX_BATCH_UPDATES, type AppendUpdateRequest, type BatchUpdatesRequest } from '@oc/shared';

export class BatchUpdatesDto implements BatchUpdatesRequest {
  @IsArray()
  @ArrayMaxSize(MAX_BATCH_UPDATES)
  @IsUUID('all', { each: true })
  docIds!: string[];
}

export class AppendUpdateDto implements AppendUpdateRequest {
  @IsString()
  @IsBase64()
  dataBase64!: string;

  @IsOptional()
  @IsISO8601()
  mtime?: string;
}
