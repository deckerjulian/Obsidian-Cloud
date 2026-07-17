import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Requires a valid access token (Authorization: Bearer ...). */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
