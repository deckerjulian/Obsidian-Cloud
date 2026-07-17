import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * End-to-end auth flow. Requires a running Postgres (DATABASE_URL) — run via
 * `pnpm test:e2e` with the docker-compose `postgres` service up. The bootstrap
 * admin is auto-created on app init.
 */
describe('Auth (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('logs in, reads /me, rotates the refresh token and detects reuse', async () => {
    const username = process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@example.com';
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'changeme';
    const server = app.getHttpServer();

    const login = await request(server).post('/api/auth/login').send({ username, password }).expect(201);
    const { accessToken, refreshToken } = login.body.tokens;
    expect(accessToken).toBeTruthy();
    expect(login.body.user.email).toBe(username.toLowerCase());

    await request(server)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // missing token → 401
    await request(server).get('/api/auth/me').expect(401);

    const refreshed = await request(server)
      .post('/api/auth/refresh')
      .send({ refreshToken })
      .expect(201);
    expect(refreshed.body.tokens.refreshToken).not.toBe(refreshToken);

    // reusing the now-rotated refresh token must be rejected
    await request(server).post('/api/auth/refresh').send({ refreshToken }).expect(401);
  });

  it('rejects bad credentials', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: 'nobody@example.com', password: 'wrong' })
      .expect(401);
  });
});
