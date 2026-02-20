import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

interface CreatedPartResponse {
  id: string;
  partNumber: string;
  name: string;
}

interface PartSummaryResponse {
  id: string;
  partNumber: string;
  name: string;
}

interface ChildPartResponse extends PartSummaryResponse {
  quantity: number;
}

interface PartDetailsResponse {
  id: string;
  partNumber: string;
  name: string;
  description: string;
  parentCount: number;
  childCount: number;
  parentParts: PartSummaryResponse[];
  childParts: ChildPartResponse[];
}

interface AuditLogResponse {
  id: string;
  partId: string;
  action: string;
  message: string;
  timestamp: string;
}

interface BomTreeNodeResponse {
  part: {
    id: string;
    partNumber: string;
    name: string;
  };
  quantityFromParent?: number;
  hasChildren: boolean;
  children: BomTreeNodeResponse[];
}

interface BomTreeResponse {
  rootPartId: string;
  requestedDepth: number;
  nodeLimit: number;
  nodeCount: number;
  tree: BomTreeNodeResponse;
}

interface BomLinkResponse {
  parentId: string;
  childId: string;
  quantity: number;
  createdAt: string;
}

interface DeleteBomLinkResponse {
  message: string;
  parentId: string;
  childId: string;
}

interface ErrorResponse {
  statusCode: number;
  message: string | string[];
  error: string;
}

const originalDatabasePath = process.env.DATABASE_PATH;
const originalSeedSampleData = process.env.SEED_SAMPLE_DATA;

async function createTestApp(): Promise<INestApplication<App>> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  await app.init();
  return app;
}

function api(app: INestApplication<App>) {
  return request(app.getHttpServer());
}

describe('Part BOM API (e2e) - In Memory', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    process.env.DATABASE_PATH = ':memory:';
    process.env.SEED_SAMPLE_DATA = 'false';
    app = await createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(() => {
    process.env.DATABASE_PATH = originalDatabasePath;
    process.env.SEED_SAMPLE_DATA = originalSeedSampleData;
  });

  async function createPart(name: string, partNumber?: string) {
    const response = await api(app)
      .post('/parts')
      .send({
        name,
        partNumber,
      })
      .expect(201);

    return response.body as CreatedPartResponse;
  }

  it('/health (GET)', async () => {
    await api(app).get('/health').expect(200).expect({
      status: 'ok',
      service: 'part-bom-management',
    });
  });

  it('creates a part and returns it in search/details/audit', async () => {
    const created = await createPart('Motor Controller', 'PRT-900001');

    expect(created.name).toBe('Motor Controller');
    expect(created.partNumber).toBe('PRT-900001');

    const searchResponse = await api(app)
      .get('/parts')
      .query({ q: 'controller' })
      .expect(200);
    const searchResults = searchResponse.body as PartSummaryResponse[];

    expect(searchResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.id,
          partNumber: 'PRT-900001',
          name: 'Motor Controller',
        }),
      ]),
    );

    const detailsResponse = await api(app)
      .get(`/parts/${created.id}`)
      .expect(200);
    const details = detailsResponse.body as PartDetailsResponse;

    expect(details.parentCount).toBe(0);
    expect(details.childCount).toBe(0);

    const auditResponse = await api(app)
      .get(`/parts/${created.id}/audit-logs`)
      .expect(200);
    const audits = auditResponse.body as AuditLogResponse[];

    expect(audits[0]).toEqual(
      expect.objectContaining({
        partId: created.id,
        action: 'PART_CREATED',
      }),
    );
  });

  it('auto-generates part number when not provided', async () => {
    const created = await createPart('Unnamed Number Part');

    expect(created.partNumber).toMatch(/^PRT-\d{6}$/);
  });

  it('creates BOM link and exposes relationship in tree and details', async () => {
    const parent = await createPart('Parent Assembly', 'PRT-910001');
    const child = await createPart('Child Assembly', 'PRT-910002');

    const linkResponse = await api(app)
      .post('/bom/links')
      .send({
        parentId: parent.id,
        childId: child.id,
        quantity: 2,
      })
      .expect(201);
    const link = linkResponse.body as BomLinkResponse;

    expect(link).toEqual(
      expect.objectContaining({
        parentId: parent.id,
        childId: child.id,
        quantity: 2,
      }),
    );

    const treeResponse = await api(app)
      .get(`/bom/${parent.id}`)
      .query({ depth: 1 })
      .expect(200);
    const tree = treeResponse.body as BomTreeResponse;

    expect(tree.tree.part.id).toBe(parent.id);
    expect(tree.tree.children.length).toBe(1);
    expect(tree.tree.children[0].part.id).toBe(child.id);
    expect(tree.tree.children[0].quantityFromParent).toBe(2);

    const parentDetailsResponse = await api(app)
      .get(`/parts/${parent.id}`)
      .expect(200);
    const parentDetails = parentDetailsResponse.body as PartDetailsResponse;

    expect(parentDetails.childCount).toBe(1);
    expect(parentDetails.childParts[0]).toEqual(
      expect.objectContaining({
        id: child.id,
        quantity: 2,
      }),
    );

    const childDetailsResponse = await api(app)
      .get(`/parts/${child.id}`)
      .expect(200);
    const childDetails = childDetailsResponse.body as PartDetailsResponse;

    expect(childDetails.parentCount).toBe(1);
    expect(childDetails.parentParts[0]).toEqual(
      expect.objectContaining({
        id: parent.id,
      }),
    );
  });

  it('updates and removes BOM link and writes audit logs', async () => {
    const parent = await createPart('Update Parent', 'PRT-920001');
    const child = await createPart('Update Child', 'PRT-920002');

    await api(app)
      .post('/bom/links')
      .send({
        parentId: parent.id,
        childId: child.id,
        quantity: 1,
      })
      .expect(201);

    const updateResponse = await api(app)
      .put('/bom/links')
      .send({
        parentId: parent.id,
        childId: child.id,
        quantity: 5,
      })
      .expect(200);
    const updatedLink = updateResponse.body as BomLinkResponse;

    expect(updatedLink).toEqual(
      expect.objectContaining({
        parentId: parent.id,
        childId: child.id,
        quantity: 5,
      }),
    );

    const afterUpdateDetailsResponse = await api(app)
      .get(`/parts/${parent.id}`)
      .expect(200);
    const afterUpdateDetails =
      afterUpdateDetailsResponse.body as PartDetailsResponse;

    expect(afterUpdateDetails.childParts[0].quantity).toBe(5);

    const deleteResponse = await api(app)
      .delete(`/bom/links/${parent.id}/${child.id}`)
      .expect(200);
    const deleted = deleteResponse.body as DeleteBomLinkResponse;

    expect(deleted).toEqual(
      expect.objectContaining({
        message: 'BOM link removed successfully.',
        parentId: parent.id,
        childId: child.id,
      }),
    );

    const afterDeleteDetailsResponse = await api(app)
      .get(`/parts/${parent.id}`)
      .expect(200);
    const afterDeleteDetails =
      afterDeleteDetailsResponse.body as PartDetailsResponse;

    expect(afterDeleteDetails.childCount).toBe(0);

    const parentAuditResponse = await api(app)
      .get(`/parts/${parent.id}/audit-logs`)
      .expect(200);
    const parentAudits = parentAuditResponse.body as AuditLogResponse[];
    const actions = parentAudits.map((entry) => entry.action);

    expect(actions).toEqual(
      expect.arrayContaining(['BOM_LINK_UPDATED', 'BOM_LINK_REMOVED']),
    );
  });

  it('prevents BOM cycles', async () => {
    const partA = await createPart('Cycle A', 'PRT-930001');
    const partB = await createPart('Cycle B', 'PRT-930002');

    await api(app)
      .post('/bom/links')
      .send({
        parentId: partA.id,
        childId: partB.id,
        quantity: 1,
      })
      .expect(201);

    const cycleResponse = await api(app)
      .post('/bom/links')
      .send({
        parentId: partB.id,
        childId: partA.id,
        quantity: 1,
      })
      .expect(400);
    const cycleError = cycleResponse.body as ErrorResponse;

    expect(cycleError.message).toBe(
      'BOM link creation failed because it would introduce a cycle.',
    );
  });
});

describe('Part BOM API (e2e) - SQLite Persistence', () => {
  afterAll(() => {
    process.env.DATABASE_PATH = originalDatabasePath;
    process.env.SEED_SAMPLE_DATA = originalSeedSampleData;
  });

  it('persists data across app restarts with file-backed sqlite', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'part-bom-e2e-'));
    const dbFile = join(tempDir, 'persist.sqlite');

    try {
      process.env.DATABASE_PATH = dbFile;
      process.env.SEED_SAMPLE_DATA = 'false';

      const appFirst = await createTestApp();

      const createdResponse = await api(appFirst)
        .post('/parts')
        .send({
          name: 'Persistent Part',
          partNumber: 'PRT-990001',
        })
        .expect(201);
      const created = createdResponse.body as CreatedPartResponse;

      await appFirst.close();

      const appSecond = await createTestApp();

      const searchResponse = await api(appSecond)
        .get('/parts')
        .query({ q: 'Persistent Part' })
        .expect(200);
      const searchResults = searchResponse.body as PartSummaryResponse[];

      expect(searchResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: created.id,
            partNumber: 'PRT-990001',
          }),
        ]),
      );

      await appSecond.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
