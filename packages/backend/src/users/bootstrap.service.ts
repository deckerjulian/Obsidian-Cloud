import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UsersService } from './users.service';

/** Creates an initial admin account on first run when the DB has no users. */
@Injectable()
export class BootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(
    private readonly users: UsersService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if ((await this.users.count()) > 0) return;

    const email = this.config.get<string>('bootstrap.adminEmail')!;
    const password = this.config.get<string>('bootstrap.adminPassword')!;
    await this.users.createLocal({ email, displayName: 'Administrator', password, isAdmin: true });
    this.logger.warn(`Created bootstrap admin '${email}'. Change this password immediately.`);
  }
}
