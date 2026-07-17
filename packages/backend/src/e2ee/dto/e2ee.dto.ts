import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type { RegisterKeysRequest, SetDocumentKeysRequest } from '@oc/shared';

export class RegisterKeysDto implements RegisterKeysRequest {
  @IsString() @MinLength(1) publicKey!: string;
  @IsString() @MinLength(1) encryptedPrivateKey!: string;
  @IsString() @MinLength(1) kdfSalt!: string;
  @IsOptional() @IsBoolean() force?: boolean;
}

class DocumentKeyEntryDto {
  @IsUUID() userId!: string;
  @IsString() @MinLength(1) wrappedKey!: string;
}

export class SetDocumentKeysDto implements SetDocumentKeysRequest {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DocumentKeyEntryDto)
  entries!: DocumentKeyEntryDto[];
}
