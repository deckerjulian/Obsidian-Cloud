import { Module } from '@nestjs/common';
import { TreeModule } from '../tree/tree.module';
import { DocumentsService } from './documents.service';
import { DocumentsController } from './documents.controller';

@Module({
  imports: [TreeModule], // provides AclService
  providers: [DocumentsService],
  controllers: [DocumentsController],
})
export class DocumentsModule {}
