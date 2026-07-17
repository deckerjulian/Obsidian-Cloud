import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { UserDto } from '@oc/shared';
import { ForbiddenException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/jwt.strategy';
import { AclService } from '../acl/acl.service';
import { UsersService, toUserDto } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly acl: AclService,
  ) {}

  /** List users (for picking share targets / admin management). The full
   *  directory (emails, admin flags) is only for admins and users who can
   *  actually share something — same gate as /e2ee/public-keys. */
  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<UserDto[]> {
    if (!(await this.acl.canShareAnywhere({ userId: user.userId, isAdmin: user.isAdmin }))) {
      throw new ForbiddenException("Requires the 'share' permission somewhere in the vault");
    }
    return (await this.users.list()).map(toUserDto);
  }

  /** Admin: create a local (password) account. */
  @Post()
  @UseGuards(AdminGuard)
  async create(@Body() dto: CreateUserDto): Promise<UserDto> {
    return toUserDto(await this.users.createLocal(dto));
  }

  /** Admin: update a user (name, admin flag, password reset). */
  @Patch(':id')
  @UseGuards(AdminGuard)
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto): Promise<UserDto> {
    return toUserDto(await this.users.update(id, dto));
  }

  /** Admin: delete a user. */
  @Delete(':id')
  @UseGuards(AdminGuard)
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.users.remove(id, user.userId);
  }
}
