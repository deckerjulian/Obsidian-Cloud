import { Body, Controller, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import type { DocumentBootstrapDto, BlobInfoDto, BlobContentDto, BatchUpdatesResponse } from '@oc/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/jwt.strategy';
import { DocumentsService } from './documents.service';
import { UploadBlobDto } from './dto/upload-blob.dto';
import { AppendUpdateDto, BatchUpdatesDto } from './dto/updates.dto';

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

  /** Declared before ':docId/…' routes for clarity; distinct method+path anyway. */
  @Post('updates')
  @HttpCode(200)
  batchUpdates(@CurrentUser() user: AuthUser, @Body() dto: BatchUpdatesDto): Promise<BatchUpdatesResponse> {
    return this.docs.batchUpdates(user, dto.docIds);
  }

  @Post(':docId/updates')
  @HttpCode(204)
  appendUpdate(
    @CurrentUser() user: AuthUser,
    @Param('docId') docId: string,
    @Body() dto: AppendUpdateDto,
  ): Promise<void> {
    return this.docs.appendUpdate(user, docId, dto.dataBase64, dto.mtime);
  }
}
