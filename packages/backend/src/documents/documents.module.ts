import { Module } from '@nestjs/common';
import { TreeModule } from '../tree/tree.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { DocumentsService } from './documents.service';
import { DocumentsController } from './documents.controller';

@Module({
  imports: [TreeModule, RealtimeModule], // AclService + live broadcast
  providers: [DocumentsService],
  controllers: [DocumentsController],
})
export class DocumentsModule {}
