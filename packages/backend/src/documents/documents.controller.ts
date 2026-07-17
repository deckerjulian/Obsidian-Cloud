import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import type { DocumentBootstrapDto, BlobInfoDto, BlobContentDto } from '@oc/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/jwt.strategy';
import { DocumentsService } from './documents.service';
import { UploadBlobDto } from './dto/upload-blob.dto';

@Controller('documents')
@UseGuards(JwtAuthGuard)
export class DocumentsController {
  constructor(private readonly docs: DocumentsService) {}

  @Get(':docId/bootstrap')
  bootstrap(
    @CurrentUser() user: AuthUser,
    @Param('docId') docId: string,
  ): Promise<DocumentBootstrapDto> {
    return this.docs.bootstrap(user, docId);
  }

  @Put(':docId/blob')
  upload(
    @CurrentUser() user: AuthUser,
    @Param('docId') docId: string,
    @Body() dto: UploadBlobDto,
  ): Promise<BlobInfoDto> {
    return this.docs.uploadBlob(user, docId, dto.contentBase64, dto.mime);
  }

  @Get(':docId/blob')
  download(@CurrentUser() user: AuthUser, @Param('docId') docId: string): Promise<BlobContentDto> {
    return this.docs.getBlob(user, docId);
  }
}
