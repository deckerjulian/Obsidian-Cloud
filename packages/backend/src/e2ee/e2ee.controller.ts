import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import type { UserKeysDto, PublicKeyDto, DocumentKeyDto, GranteeKeyDto } from '@oc/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/jwt.strategy';
import { E2eeService } from './e2ee.service';
import { RegisterKeysDto, SetDocumentKeysDto } from './dto/e2ee.dto';

@Controller('e2ee')
@UseGuards(JwtAuthGuard)
export class E2eeController {
  constructor(private readonly e2ee: E2eeService) {}

  /** Register (or replace) the current user's key pair. */
  @Post('keys')
  @HttpCode(204)
  register(@CurrentUser() user: AuthUser, @Body() dto: RegisterKeysDto): Promise<void> {
    return this.e2ee.registerKeys(user.userId, dto);
  }

  @Get('keys/me')
  myKeys(@CurrentUser() user: AuthUser): Promise<UserKeysDto> {
    return this.e2ee.getMyKeys(user.userId);
  }

  /** Public keys of all users, for wrapping document keys when sharing.
   *  Restricted to admins/sharers — it reveals the user directory. */
  @Get('public-keys')
  publicKeys(@CurrentUser() user: AuthUser): Promise<PublicKeyDto[]> {
    return this.e2ee.listPublicKeys(user);
  }

  /** Public keys of the other users who already have access to a document's
   *  subtree, so the caller can key a newly created node for them. */
  @Get('grantees/:docId')
  grantees(@CurrentUser() user: AuthUser, @Param('docId') docId: string): Promise<GranteeKeyDto[]> {
    return this.e2ee.listGrantees(user, docId);
  }

  /** Public keys of all admins, so any user can key their documents for the
   *  admins (who have full read access to every file by policy). */
  @Get('admin-keys')
  adminKeys(): Promise<GranteeKeyDto[]> {
    return this.e2ee.listAdminKeys();
  }

  /** All wrapped content keys of the current user (bulk cache prime for sync). */
  @Get('document-keys')
  myDocumentKeys(@CurrentUser() user: AuthUser): Promise<DocumentKeyDto[]> {
    return this.e2ee.listMyDocumentKeys(user.userId);
  }

  @Get('document-keys/:docId')
  documentKey(@CurrentUser() user: AuthUser, @Param('docId') docId: string): Promise<DocumentKeyDto> {
    return this.e2ee.getDocumentKey(user, docId);
  }

  @Put('document-keys/:docId')
  @HttpCode(204)
  setDocumentKeys(
    @CurrentUser() user: AuthUser,
    @Param('docId') docId: string,
    @Body() dto: SetDocumentKeysDto,
  ): Promise<void> {
    return this.e2ee.setDocumentKeys(user, docId, dto);
  }

  /** Revoke a user's access to a document's content key. */
  @Delete('document-keys/:docId/:userId')
  @HttpCode(204)
  removeDocumentKey(
    @CurrentUser() user: AuthUser,
    @Param('docId') docId: string,
    @Param('userId') userId: string,
  ): Promise<void> {
    return this.e2ee.removeDocumentKey(user, docId, userId);
  }
}
