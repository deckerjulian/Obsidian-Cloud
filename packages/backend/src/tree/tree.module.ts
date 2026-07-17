import { Module } from '@nestjs/common';
import { AclService } from '../acl/acl.service';
import { NodesService } from './nodes.service';
import { TreeController } from './tree.controller';
import { AclController } from './acl.controller';

@Module({
  providers: [AclService, NodesService],
  controllers: [TreeController, AclController],
  exports: [AclService, NodesService],
})
export class TreeModule {}
