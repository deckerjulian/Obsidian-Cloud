import { Body, Controller, Delete, Get, HttpCode, Param, Put, UseGuards } from '@nestjs/common';
import type { AclEntryDto, AclListResponse } from '@oc/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/jwt.strategy';
import { AclService } from '../acl/acl.service';
import { SetAclDto } from './dto/set-acl.dto';

@Controller('nodes/:id/acl')
@UseGuards(JwtAuthGuard)
export class AclController {
  constructor(private readonly acl: AclService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<AclListResponse> {
    return this.acl.listAcl(user, id);
  }

  @Put()
  set(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SetAclDto,
  ): Promise<AclEntryDto> {
    return this.acl.setAcl(user, id, dto);
  }

  @Delete(':userId')
  @HttpCode(204)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ): Promise<void> {
    return this.acl.removeAcl(user, id, userId);
  }
}
