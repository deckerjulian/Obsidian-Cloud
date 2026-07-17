import { Module } from '@nestjs/common';
import { TreeModule } from '../tree/tree.module';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { BootstrapService } from './bootstrap.service';

@Module({
  imports: [TreeModule], // provides AclService (gates the user directory)
  providers: [UsersService, BootstrapService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
