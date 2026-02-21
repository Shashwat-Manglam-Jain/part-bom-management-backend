import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
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

function getErrorMessage(body: ErrorResponse): string {
  if (Array.isArray(body.message)) {
    return body.message.join(', ');
  }

  return body.message;
}

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalSeedSampleData = process.env.SEED_SAMPLE_DATA;
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

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

async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.auditLog.deleteMany();
  await prisma.bomLink.deleteMany();
  await prisma.part.deleteMany();
}

const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase('Part BOM API (e2e) - PostgreSQL', () => {
  let app: INestApplication<App> | undefined;
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.SEED_SAMPLE_DATA = 'false';

    prisma = new PrismaClient();
    await prisma.$connect();
  });

  beforeEach(async () => {
    if (!prisma) {
      throw new Error('Prisma test client is not initialized.');
    }

    await resetDatabase(prisma);
    app = await createTestApp();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$disconnect();
      prisma = undefined;
    }

    process.env.DATABASE_URL = originalDatabaseUrl;
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

  it('searches parts by partNumber and name filters', async () => {
    const motor = await createPart('Drive Motor', 'PRT-940001');
    const sensor = await createPart('Thermal Sensor', 'PRT-940002');

    const byPartNumberResponse = await api(app)
      .get('/parts')
      .query({ partNumber: '940001' })
      .expect(200);
    const byPartNumber = byPartNumberResponse.body as PartSummaryResponse[];

    expect(byPartNumber).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: motor.id,
        }),
      ]),
    );
    expect(byPartNumber).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({
          id: sensor.id,
        }),
      ]),
    );

    const byNameResponse = await api(app)
      .get('/parts')
      .query({ name: 'sensor' })
      .expect(200);
    const byName = byNameResponse.body as PartSummaryResponse[];

    expect(byName).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: sensor.id,
        }),
      ]),
    );
    expect(byName).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({
          id: motor.id,
        }),
      ]),
    );
  });

  it('rejects part creation when name is missing', async () => {
    const response = await api(app)
      .post('/parts')
      .send({
        partNumber: 'PRT-940050',
      })
      .expect(400);
    const error = response.body as ErrorResponse;

    expect(getErrorMessage(error)).toBe('Part name is required.');
  });

  it('rejects duplicate part numbers', async () => {
    await createPart('Duplicate A', 'PRT-940100');

    const duplicateResponse = await api(app)
      .post('/parts')
      .send({
        name: 'Duplicate B',
        partNumber: 'PRT-940100',
      })
      .expect(400);
    const duplicateError = duplicateResponse.body as ErrorResponse;

    expect(getErrorMessage(duplicateError)).toBe(
      "Part number 'PRT-940100' already exists.",
    );
  });

  it('updates a part through PUT /parts/:partId', async () => {
    const created = await createPart('Original Name', 'PRT-940200');

    const updateResponse = await api(app)
      .put(`/parts/${created.id}`)
      .send({
        name: 'Updated Name',
        description: 'Updated description',
        partNumber: 'PRT-940201',
      })
      .expect(200);
    const updated = updateResponse.body as CreatedPartResponse & {
      description: string;
    };

    expect(updated).toEqual(
      expect.objectContaining({
        id: created.id,
        name: 'Updated Name',
        partNumber: 'PRT-940201',
        description: 'Updated description',
      }),
    );

    const detailsResponse = await api(app)
      .get(`/parts/${created.id}`)
      .expect(200);
    const details = detailsResponse.body as PartDetailsResponse;

    expect(details.name).toBe('Updated Name');
    expect(details.partNumber).toBe('PRT-940201');
    expect(details.description).toBe('Updated description');
  });

  it('rejects part update when payload is empty', async () => {
    const created = await createPart('No-Op Update', 'PRT-940300');

    const response = await api(app).put(`/parts/${created.id}`).send({}).expect(400);
    const error = response.body as ErrorResponse;

    expect(getErrorMessage(error)).toBe(
      'At least one field must be provided for update.',
    );
  });

  it('returns 404 when updating a missing part', async () => {
    const response = await api(app)
      .put('/parts/PART-9999')
      .send({
        name: 'Updated Missing',
      })
      .expect(404);
    const error = response.body as ErrorResponse;

    expect(getErrorMessage(error)).toBe("Part 'PART-9999' was not found.");
  });

  it('rejects part update when provided name or part number is blank', async () => {
    const created = await createPart('Blank Field Checks', 'PRT-940350');

    const blankNameResponse = await api(app)
      .put(`/parts/${created.id}`)
      .send({
        name: '   ',
      })
      .expect(400);
    const blankNameError = blankNameResponse.body as ErrorResponse;
    expect(getErrorMessage(blankNameError)).toBe('Part name cannot be empty.');

    const blankPartNumberResponse = await api(app)
      .put(`/parts/${created.id}`)
      .send({
        partNumber: '   ',
      })
      .expect(400);
    const blankPartNumberError = blankPartNumberResponse.body as ErrorResponse;
    expect(getErrorMessage(blankPartNumberError)).toBe(
      'Part number cannot be empty when provided.',
    );
  });

  it('returns 404 for part details and audit-logs when part does not exist', async () => {
    const detailsResponse = await api(app).get('/parts/PART-9999').expect(404);
    const detailsError = detailsResponse.body as ErrorResponse;
    expect(getErrorMessage(detailsError)).toBe("Part 'PART-9999' was not found.");

    const auditResponse = await api(app)
      .get('/parts/PART-9999/audit-logs')
      .expect(404);
    const auditError = auditResponse.body as ErrorResponse;
    expect(getErrorMessage(auditError)).toBe("Part 'PART-9999' was not found.");
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

  it('supports depth=all and returns deeper BOM nodes', async () => {
    const root = await createPart('Root Assembly', 'PRT-945001');
    const child = await createPart('Child Module', 'PRT-945002');
    const grandChild = await createPart('Grandchild Component', 'PRT-945003');

    await api(app)
      .post('/bom/links')
      .send({
        parentId: root.id,
        childId: child.id,
        quantity: 1,
      })
      .expect(201);

    await api(app)
      .post('/bom/links')
      .send({
        parentId: child.id,
        childId: grandChild.id,
        quantity: 3,
      })
      .expect(201);

    const treeResponse = await api(app)
      .get(`/bom/${root.id}`)
      .query({ depth: 'all', nodeLimit: 80 })
      .expect(200);
    const tree = treeResponse.body as BomTreeResponse;

    expect(tree.requestedDepth).toBe(5);
    expect(tree.tree.children[0].part.id).toBe(child.id);
    expect(tree.tree.children[0].children[0].part.id).toBe(grandChild.id);
    expect(tree.tree.children[0].children[0].quantityFromParent).toBe(3);
  });

  it('validates BOM tree query parameters', async () => {
    const root = await createPart('Query Root', 'PRT-946001');

    const invalidDepthResponse = await api(app)
      .get(`/bom/${root.id}`)
      .query({ depth: 'invalid' })
      .expect(400);
    const invalidDepthError = invalidDepthResponse.body as ErrorResponse;
    expect(getErrorMessage(invalidDepthError)).toBe(
      'Depth must be a number or "all".',
    );

    const invalidNodeLimitResponse = await api(app)
      .get(`/bom/${root.id}`)
      .query({ nodeLimit: 'invalid' })
      .expect(400);
    const invalidNodeLimitError = invalidNodeLimitResponse.body as ErrorResponse;
    expect(getErrorMessage(invalidNodeLimitError)).toBe(
      'nodeLimit must be a number.',
    );
  });

  it('enforces BOM tree depth and node limit boundaries', async () => {
    const root = await createPart('Limit Root', 'PRT-946101');
    const child = await createPart('Limit Child', 'PRT-946102');

    await api(app)
      .post('/bom/links')
      .send({
        parentId: root.id,
        childId: child.id,
        quantity: 1,
      })
      .expect(201);

    const negativeDepthResponse = await api(app)
      .get(`/bom/${root.id}`)
      .query({ depth: -1 })
      .expect(400);
    const negativeDepthError = negativeDepthResponse.body as ErrorResponse;
    expect(getErrorMessage(negativeDepthError)).toBe(
      'Depth must be an integer >= 0.',
    );

    const tooDeepResponse = await api(app)
      .get(`/bom/${root.id}`)
      .query({ depth: 6 })
      .expect(400);
    const tooDeepError = tooDeepResponse.body as ErrorResponse;
    expect(getErrorMessage(tooDeepError)).toBe(
      'Expand limit exceeded. Maximum supported depth is 5.',
    );

    const zeroNodeLimitResponse = await api(app)
      .get(`/bom/${root.id}`)
      .query({ nodeLimit: 0 })
      .expect(400);
    const zeroNodeLimitError = zeroNodeLimitResponse.body as ErrorResponse;
    expect(getErrorMessage(zeroNodeLimitError)).toBe(
      'Node limit must be an integer > 0.',
    );

    const tooLargeNodeLimitResponse = await api(app)
      .get(`/bom/${root.id}`)
      .query({ nodeLimit: 81 })
      .expect(400);
    const tooLargeNodeLimitError = tooLargeNodeLimitResponse.body as ErrorResponse;
    expect(getErrorMessage(tooLargeNodeLimitError)).toBe(
      'Node limit too large. Maximum supported node limit is 80.',
    );

    const exceededNodeLimitResponse = await api(app)
      .get(`/bom/${root.id}`)
      .query({ depth: 1, nodeLimit: 1 })
      .expect(400);
    const exceededNodeLimitError = exceededNodeLimitResponse.body as ErrorResponse;
    expect(getErrorMessage(exceededNodeLimitError)).toBe(
      'BOM expansion exceeded node limit of 1. Reduce depth or load incrementally.',
    );
  });

  it('returns 404 for BOM tree when root part does not exist', async () => {
    const response = await api(app).get('/bom/PART-9999').expect(404);
    const error = response.body as ErrorResponse;

    expect(getErrorMessage(error)).toBe("Part 'PART-9999' was not found.");
  });

  it('validates BOM link creation payload and constraints', async () => {
    const parent = await createPart('Create Parent', 'PRT-947001');
    const child = await createPart('Create Child', 'PRT-947002');

    const missingIdsResponse = await api(app).post('/bom/links').send({}).expect(400);
    const missingIdsError = missingIdsResponse.body as ErrorResponse;
    expect(getErrorMessage(missingIdsError)).toBe(
      'Both parentId and childId are required.',
    );

    const selfLinkResponse = await api(app)
      .post('/bom/links')
      .send({
        parentId: parent.id,
        childId: parent.id,
        quantity: 1,
      })
      .expect(400);
    const selfLinkError = selfLinkResponse.body as ErrorResponse;
    expect(getErrorMessage(selfLinkError)).toBe(
      'A part cannot be linked to itself in BOM.',
    );

    const invalidQuantityResponse = await api(app)
      .post('/bom/links')
      .send({
        parentId: parent.id,
        childId: child.id,
        quantity: 0,
      })
      .expect(400);
    const invalidQuantityError = invalidQuantityResponse.body as ErrorResponse;
    expect(getErrorMessage(invalidQuantityError)).toBe(
      'BOM quantity must be a positive integer.',
    );

    await api(app)
      .post('/bom/links')
      .send({
        parentId: parent.id,
        childId: child.id,
        quantity: 2,
      })
      .expect(201);

    const duplicateResponse = await api(app)
      .post('/bom/links')
      .send({
        parentId: parent.id,
        childId: child.id,
        quantity: 2,
      })
      .expect(400);
    const duplicateError = duplicateResponse.body as ErrorResponse;
    expect(getErrorMessage(duplicateError)).toBe(
      'BOM link already exists between PRT-947001 and PRT-947002.',
    );
  });

  it('returns 404 for BOM link creation when parent or child part is missing', async () => {
    const existing = await createPart('Existing Link Part', 'PRT-947101');

    const missingParentResponse = await api(app)
      .post('/bom/links')
      .send({
        parentId: 'PART-9999',
        childId: existing.id,
        quantity: 1,
      })
      .expect(404);
    const missingParentError = missingParentResponse.body as ErrorResponse;
    expect(getErrorMessage(missingParentError)).toBe("Part 'PART-9999' was not found.");

    const missingChildResponse = await api(app)
      .post('/bom/links')
      .send({
        parentId: existing.id,
        childId: 'PART-8888',
        quantity: 1,
      })
      .expect(404);
    const missingChildError = missingChildResponse.body as ErrorResponse;
    expect(getErrorMessage(missingChildError)).toBe("Part 'PART-8888' was not found.");
  });

  it('validates BOM link update payload and missing link handling', async () => {
    const parent = await createPart('Update Parent 2', 'PRT-948001');
    const child = await createPart('Update Child 2', 'PRT-948002');

    const missingIdsResponse = await api(app)
      .put('/bom/links')
      .send({ quantity: 2 })
      .expect(400);
    const missingIdsError = missingIdsResponse.body as ErrorResponse;
    expect(getErrorMessage(missingIdsError)).toBe(
      'Both parentId and childId are required.',
    );

    const missingQuantityResponse = await api(app)
      .put('/bom/links')
      .send({
        parentId: parent.id,
        childId: child.id,
      })
      .expect(400);
    const missingQuantityError = missingQuantityResponse.body as ErrorResponse;
    expect(getErrorMessage(missingQuantityError)).toBe('Quantity is required.');

    const missingLinkResponse = await api(app)
      .put('/bom/links')
      .send({
        parentId: parent.id,
        childId: child.id,
        quantity: 2,
      })
      .expect(404);
    const missingLinkError = missingLinkResponse.body as ErrorResponse;
    expect(getErrorMessage(missingLinkError)).toBe(
      'No BOM link exists between PRT-948001 and PRT-948002.',
    );
  });

  it('rejects BOM link update for invalid quantity and missing parts', async () => {
    const parent = await createPart('Update Parent 3', 'PRT-948101');
    const child = await createPart('Update Child 3', 'PRT-948102');

    await api(app)
      .post('/bom/links')
      .send({
        parentId: parent.id,
        childId: child.id,
        quantity: 1,
      })
      .expect(201);

    const invalidQuantityResponse = await api(app)
      .put('/bom/links')
      .send({
        parentId: parent.id,
        childId: child.id,
        quantity: -2,
      })
      .expect(400);
    const invalidQuantityError = invalidQuantityResponse.body as ErrorResponse;
    expect(getErrorMessage(invalidQuantityError)).toBe(
      'BOM quantity must be a positive integer.',
    );

    const missingPartResponse = await api(app)
      .put('/bom/links')
      .send({
        parentId: 'PART-7777',
        childId: child.id,
        quantity: 1,
      })
      .expect(404);
    const missingPartError = missingPartResponse.body as ErrorResponse;
    expect(getErrorMessage(missingPartError)).toBe("Part 'PART-7777' was not found.");
  });

  it('returns 404 when deleting a non-existent BOM link', async () => {
    const parent = await createPart('Delete Parent 2', 'PRT-949001');
    const child = await createPart('Delete Child 2', 'PRT-949002');

    const response = await api(app)
      .delete(`/bom/links/${parent.id}/${child.id}`)
      .expect(404);
    const error = response.body as ErrorResponse;

    expect(getErrorMessage(error)).toBe(
      'No BOM link exists between PRT-949001 and PRT-949002.',
    );
  });

  it('returns 404 when deleting BOM link and one part does not exist', async () => {
    const existing = await createPart('Delete Existing', 'PRT-949101');

    const response = await api(app)
      .delete(`/bom/links/PART-6666/${existing.id}`)
      .expect(404);
    const error = response.body as ErrorResponse;

    expect(getErrorMessage(error)).toBe("Part 'PART-6666' was not found.");
  });

  it('persists data across app restarts with postgres', async () => {
    const createdResponse = await api(app)
      .post('/parts')
      .send({
        name: 'Persistent Part',
        partNumber: 'PRT-990001',
      })
      .expect(201);
    const created = createdResponse.body as CreatedPartResponse;

    await app.close();

    app = await createTestApp();

    const searchResponse = await api(app)
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
  });
});
