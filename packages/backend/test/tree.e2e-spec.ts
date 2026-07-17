import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Tree + ACL permission matrix. Requires Postgres (run via `pnpm test:e2e`).
 * Exercises inheritance, viewer-cannot-write, editor-can-write and visibility.
 */
describe('Tree + ACL (e2e)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  const stamp = Date.now();

  async function login(username: string, password: string): Promise<string> {
    const res = await request(server).post('/api/auth/login').send({ username, password }).expect(201);
    return res.body.tokens.accessToken as string;
  }
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  let adminToken: string;
  let teamId: string;
  let fileId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
    server = app.getHttpServer();

    adminToken = await login(
      process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@example.com',
      process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'changeme',
    );

    const team = await request(server)
      .post('/api/nodes')
      .set(bearer(adminToken))
      .send({ parentId: null, kind: 'folder', name: `Team-${stamp}` })
      .expect(201);
    teamId = team.body.id;

    const file = await request(server)
      .post('/api/nodes')
      .set(bearer(adminToken))
      .send({ parentId: teamId, kind: 'file', name: 'note.md' })
      .expect(201);
    fileId = file.body.id;
    expect(file.body.docId).toBeTruthy(); // files get a stable docId
  });

  afterAll(async () => {
    await app?.close();
  });

  async function createUser(label: string): Promise<{ id: string; token: string }> {
    const email = `${label}-${stamp}@example.com`;
    const password = 'password123';
    const created = await request(server)
      .post('/api/users')
      .set(bearer(adminToken))
      .send({ email, displayName: label, password })
      .expect(201);
    const token = await login(email, password);
    return { id: created.body.id, token };
  }

  it('grants inherited access and enforces viewer vs editor', async () => {
    const viewer = await createUser('viewer');
    const editor = await createUser('editor');

    // Grant roles on the Team folder; they inherit down to note.md.
    await request(server)
      .put(`/api/nodes/${teamId}/acl`)
      .set(bearer(adminToken))
      .send({ userId: viewer.id, role: 'viewer' })
      .expect(200);
    await request(server)
      .put(`/api/nodes/${teamId}/acl`)
      .set(bearer(adminToken))
      .send({ userId: editor.id, role: 'editor' })
      .expect(200);

    // Viewer sees the subtree with role 'viewer'…
    const viewerTree = await request(server).get('/api/tree').set(bearer(viewer.token)).expect(200);
    const seenFile = viewerTree.body.nodes.find((n: { id: string }) => n.id === fileId);
    expect(seenFile?.role).toBe('viewer');

    // …but cannot create or rename (403).
    await request(server)
      .post('/api/nodes')
      .set(bearer(viewer.token))
      .send({ parentId: teamId, kind: 'file', name: 'nope.md' })
      .expect(403);
    await request(server)
      .patch(`/api/nodes/${fileId}`)
      .set(bearer(viewer.token))
      .send({ name: 'renamed.md' })
      .expect(403);

    // Editor can create and rename.
    await request(server)
      .post('/api/nodes')
      .set(bearer(editor.token))
      .send({ parentId: teamId, kind: 'file', name: 'editor-note.md' })
      .expect(201);
    await request(server)
      .patch(`/api/nodes/${fileId}`)
      .set(bearer(editor.token))
      .send({ name: 'renamed.md' })
      .expect(200);

    // Viewer cannot manage sharing (needs owner).
    await request(server)
      .get(`/api/nodes/${teamId}/acl`)
      .set(bearer(viewer.token))
      .expect(403);
  });

  it('hides nodes from users without any grant', async () => {
    const stranger = await createUser('stranger'); // created, but no grant on Team
    const tree = await request(server).get('/api/tree').set(bearer(stranger.token)).expect(200);
    const seesTeam = tree.body.nodes.some((n: { id: string }) => n.id === teamId);
    expect(seesTeam).toBe(false);
  });
});
