import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthUser } from './jwt.strategy';

/** Requires the authenticated user to be an admin. Use after JwtAuthGuard. */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    if (!req.user?.isAdmin) throw new ForbiddenException('Admin privileges required');
    return true;
  }
}
