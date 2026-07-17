import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import type { AuthConfigDto } from '@oc/shared';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AdminGuard } from './admin.guard';
import { AuthConfigService } from './auth-config.service';
import { UpdateAuthConfigDto } from './dto/update-auth-config.dto';

@Controller('admin/auth-config')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AuthConfigController {
  constructor(private readonly cfg: AuthConfigService) {}

  @Get()
  get(): Promise<AuthConfigDto> {
    return this.cfg.getDto();
  }

  @Put()
  update(@Body() dto: UpdateAuthConfigDto): Promise<AuthConfigDto> {
    return this.cfg.update(dto);
  }
}
