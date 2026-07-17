import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { TreeNodeDto, TreeResponse } from '@oc/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/jwt.strategy';
import { NodesService } from './nodes.service';
import { CreateNodeDto } from './dto/create-node.dto';
import { UpdateNodeDto } from './dto/update-node.dto';

/** The slice of Express' Response used for ETag handling (avoids a direct
 *  dependency on express' type package). */
interface EtagResponse {
  setHeader(name: string, value: string): void;
  status(code: number): unknown;
}

@Controller()
@UseGuards(JwtAuthGuard)
export class TreeController {
  constructor(private readonly nodes: NodesService) {}

  /** The tree, with ETag/304 support so background polls stay cheap. The
   *  fingerprint is global (nodes + grants); the user id is mixed in because
   *  the body itself is per-user. */
  @Get('tree')
  async tree(
    @CurrentUser() user: AuthUser,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: EtagResponse,
  ): Promise<TreeResponse | undefined> {
    const etag = `W/"${await this.nodes.treeVersion()}.${user.userId}"`;
    res.setHeader('ETag', etag);
    if (ifNoneMatch === etag) {
      res.status(304);
      return undefined;
    }
    return this.nodes.getTree(user);
  }

  @Post('nodes')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateNodeDto): Promise<TreeNodeDto> {
    return this.nodes.create(user, dto);
  }

  @Patch('nodes/:id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateNodeDto,
  ): Promise<TreeNodeDto> {
    return this.nodes.update(user, id, dto);
  }

  @Delete('nodes/:id')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    return this.nodes.remove(user, id);
  }
}
