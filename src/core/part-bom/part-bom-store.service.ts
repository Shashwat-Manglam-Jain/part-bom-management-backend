import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { AuditAction as PrismaAuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  AuditAction,
  AuditLog,
  BomLink,
  BomTreeNode,
  BomTreeResponse,
  ChildPartUsage,
  Part,
  PartDetails,
  PartSearchFilters,
  PartSummary,
} from './part-bom.models';

interface CreatePartInput {
  partNumber?: string;
  name: string;
  description?: string;
}

interface UpdatePartInput {
  partNumber?: string;
  name?: string;
  description?: string;
}

interface CreateBomLinkInput {
  parentId: string;
  childId: string;
  quantity?: number;
}

interface UpdateBomLinkInput {
  parentId: string;
  childId: string;
  quantity: number;
}

interface SeedPartDefinition {
  key: string;
  partNumber: string;
  name: string;
  description?: string;
}

interface SeedBomLinkDefinition {
  parentKey: string;
  childKey: string;
  quantity: number;
}

interface PrismaPartRecord {
  id: string;
  partNumber: string;
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
}

interface PrismaBomLinkRecord {
  parentId: string;
  childId: string;
  quantity: number;
  createdAt: Date;
}

type TxClient = Prisma.TransactionClient;

const SEED_PARTS: SeedPartDefinition[] = [
  {
    key: 'root',
    partNumber: 'PRT-000001',
    name: 'Autonomous Cart Assembly',
    description: 'Root product assembly used for startup sample data.',
  },
  { key: 'mechanical', partNumber: 'PRT-000002', name: 'Mechanical Module' },
  { key: 'electrical', partNumber: 'PRT-000003', name: 'Electrical Module' },
  { key: 'controls', partNumber: 'PRT-000004', name: 'Controls Module' },
  { key: 'basePlate', partNumber: 'PRT-000005', name: 'Base Plate' },
  { key: 'suspension', partNumber: 'PRT-000006', name: 'Suspension Kit' },
  { key: 'wheelSet', partNumber: 'PRT-000007', name: 'Wheel Set' },
  { key: 'harness', partNumber: 'PRT-000008', name: 'Primary Harness' },
  { key: 'batteryPack', partNumber: 'PRT-000009', name: 'Battery Pack' },
  { key: 'safetyRelay', partNumber: 'PRT-000010', name: 'Safety Relay' },
  {
    key: 'controllerBoard',
    partNumber: 'PRT-000011',
    name: 'Controller Board',
  },
  { key: 'operatorPanel', partNumber: 'PRT-000012', name: 'Operator Panel' },
  { key: 'coolingModule', partNumber: 'PRT-000013', name: 'Cooling Module' },
  {
    key: 'frontLeftWheel',
    partNumber: 'PRT-000014',
    name: 'Front Left Wheel',
  },
  {
    key: 'frontRightWheel',
    partNumber: 'PRT-000015',
    name: 'Front Right Wheel',
  },
  { key: 'rearLeftWheel', partNumber: 'PRT-000016', name: 'Rear Left Wheel' },
  {
    key: 'rearRightWheel',
    partNumber: 'PRT-000017',
    name: 'Rear Right Wheel',
  },
  { key: 'lidar', partNumber: 'PRT-000018', name: 'LiDAR Sensor' },
  { key: 'imu', partNumber: 'PRT-000019', name: 'IMU Sensor' },
  { key: 'cpuModule', partNumber: 'PRT-000020', name: 'CPU Module' },
  { key: 'ioModule', partNumber: 'PRT-000021', name: 'I/O Module' },
];

const SEED_BOM_LINKS: SeedBomLinkDefinition[] = [
  { parentKey: 'root', childKey: 'mechanical', quantity: 1 },
  { parentKey: 'root', childKey: 'electrical', quantity: 1 },
  { parentKey: 'root', childKey: 'controls', quantity: 1 },
  { parentKey: 'mechanical', childKey: 'basePlate', quantity: 1 },
  { parentKey: 'mechanical', childKey: 'suspension', quantity: 1 },
  { parentKey: 'mechanical', childKey: 'wheelSet', quantity: 1 },
  { parentKey: 'wheelSet', childKey: 'frontLeftWheel', quantity: 1 },
  { parentKey: 'wheelSet', childKey: 'frontRightWheel', quantity: 1 },
  { parentKey: 'wheelSet', childKey: 'rearLeftWheel', quantity: 1 },
  { parentKey: 'wheelSet', childKey: 'rearRightWheel', quantity: 1 },
  { parentKey: 'electrical', childKey: 'harness', quantity: 1 },
  { parentKey: 'electrical', childKey: 'batteryPack', quantity: 1 },
  { parentKey: 'electrical', childKey: 'safetyRelay', quantity: 1 },
  { parentKey: 'controls', childKey: 'controllerBoard', quantity: 1 },
  { parentKey: 'controls', childKey: 'operatorPanel', quantity: 1 },
  { parentKey: 'controls', childKey: 'coolingModule', quantity: 1 },
  { parentKey: 'controllerBoard', childKey: 'lidar', quantity: 1 },
  { parentKey: 'controllerBoard', childKey: 'imu', quantity: 1 },
  { parentKey: 'controllerBoard', childKey: 'cpuModule', quantity: 1 },
  { parentKey: 'controllerBoard', childKey: 'ioModule', quantity: 1 },
];

@Injectable()
export class PartBomStoreService implements OnModuleInit {
  readonly maxExpandDepth = 5;
  readonly maxExpandNodeLimit = 80;

  private partIdSequence = 1;
  private auditLogSequence = 1;
  private partNumberSequence = 1;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.initializeSequences();

      const shouldSeed =
        (process.env.SEED_SAMPLE_DATA ?? 'true').toLowerCase() !== 'false';
      if (shouldSeed) {
        await this.seedSampleData();
      }
    } catch (error) {
      this.rethrowMissingSchemaError(error);
    }
  }

  async createPart(input: CreatePartInput): Promise<Part> {
    const normalizedName = input.name.trim();
    if (!normalizedName) {
      throw new BadRequestException('Part name is required.');
    }

    const requestedPartNumber = input.partNumber?.trim().toUpperCase();
    const partNumber =
      requestedPartNumber && requestedPartNumber.length > 0
        ? requestedPartNumber
        : await this.allocatePartNumber();

    await this.assertPartNumberIsAvailable(partNumber);

    const created = await this.prisma.$transaction(async (tx) => {
      const part = await tx.part.create({
        data: {
          id: this.allocatePartId(),
          partNumber,
          name: normalizedName,
          description: input.description?.trim() ?? '',
        },
      });

      this.updatePartNumberSequence(part.partNumber);

      await this.writeAudit(
        tx,
        part.id,
        'PART_CREATED',
        `Part ${part.partNumber} was created.`,
        {
          name: part.name,
        },
      );

      return part;
    });

    return this.toPart(created);
  }

  async updatePart(partId: string, input: UpdatePartInput): Promise<Part> {
    const part = await this.requirePart(partId);

    const nextName = input.name !== undefined ? input.name.trim() : part.name;
    if (!nextName) {
      throw new BadRequestException('Part name cannot be empty.');
    }

    const nextDescription =
      input.description !== undefined
        ? input.description.trim()
        : part.description;

    let nextPartNumber = part.partNumber;
    if (input.partNumber !== undefined) {
      const normalizedPartNumber = input.partNumber.trim().toUpperCase();
      if (!normalizedPartNumber) {
        throw new BadRequestException(
          'Part number cannot be empty when provided.',
        );
      }

      if (normalizedPartNumber !== part.partNumber) {
        await this.assertPartNumberIsAvailable(normalizedPartNumber, partId);
        this.updatePartNumberSequence(normalizedPartNumber);
      }

      nextPartNumber = normalizedPartNumber;
    }

    const updatedPart = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.part.update({
        where: {
          id: partId,
        },
        data: {
          partNumber: nextPartNumber,
          name: nextName,
          description: nextDescription,
        },
      });

      await this.writeAudit(
        tx,
        partId,
        'PART_UPDATED',
        `Part ${updated.partNumber} was updated.`,
        {
          name: updated.name,
        },
      );

      return updated;
    });

    return this.toPart(updatedPart);
  }

  async searchParts(filters: PartSearchFilters): Promise<PartSummary[]> {
    const byPartNumber = filters.partNumber?.trim();
    const byName = filters.name?.trim();
    const byAny = filters.q?.trim();

    const conditions: Prisma.PartWhereInput[] = [];

    if (byPartNumber) {
      conditions.push({
        partNumber: {
          contains: byPartNumber,
          mode: 'insensitive',
        },
      });
    }

    if (byName) {
      conditions.push({
        name: {
          contains: byName,
          mode: 'insensitive',
        },
      });
    }

    if (byAny) {
      conditions.push({
        OR: [
          {
            name: {
              contains: byAny,
              mode: 'insensitive',
            },
          },
          {
            partNumber: {
              contains: byAny,
              mode: 'insensitive',
            },
          },
        ],
      });
    }

    const rows = await this.prisma.part.findMany({
      where: conditions.length > 0 ? { AND: conditions } : undefined,
      orderBy: {
        partNumber: 'asc',
      },
      select: {
        id: true,
        partNumber: true,
        name: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      partNumber: row.partNumber,
      name: row.name,
    }));
  }

  async getPartDetails(partId: string): Promise<PartDetails> {
    const part = await this.requirePart(partId);

    const [parentLinks, childLinks] = await Promise.all([
      this.prisma.bomLink.findMany({
        where: {
          childId: partId,
        },
        orderBy: {
          parent: {
            partNumber: 'asc',
          },
        },
        select: {
          parent: {
            select: {
              id: true,
              partNumber: true,
              name: true,
            },
          },
        },
      }),
      this.prisma.bomLink.findMany({
        where: {
          parentId: partId,
        },
        orderBy: {
          child: {
            partNumber: 'asc',
          },
        },
        select: {
          quantity: true,
          child: {
            select: {
              id: true,
              partNumber: true,
              name: true,
            },
          },
        },
      }),
    ]);

    const parentParts: PartSummary[] = parentLinks.map((row) => ({
      id: row.parent.id,
      partNumber: row.parent.partNumber,
      name: row.parent.name,
    }));

    const childParts: ChildPartUsage[] = childLinks.map((row) => ({
      id: row.child.id,
      partNumber: row.child.partNumber,
      name: row.child.name,
      quantity: row.quantity,
    }));

    return {
      ...part,
      parentCount: parentParts.length,
      childCount: childParts.length,
      parentParts,
      childParts,
    };
  }

  async getPartAuditLogs(partId: string): Promise<AuditLog[]> {
    await this.requirePart(partId);

    const rows = await this.prisma.auditLog.findMany({
      where: {
        partId,
      },
      orderBy: {
        timestamp: 'desc',
      },
    });

    return rows.map((row) => ({
      id: row.id,
      partId: row.partId,
      action: row.action,
      message: row.message,
      timestamp: row.timestamp.toISOString(),
      metadata: this.toAuditMetadata(row.metadata),
    }));
  }

  async createBomLink(input: CreateBomLinkInput): Promise<BomLink> {
    const [parent, child] = await Promise.all([
      this.requirePart(input.parentId),
      this.requirePart(input.childId),
    ]);

    if (parent.id === child.id) {
      throw new BadRequestException(
        'A part cannot be linked to itself in BOM.',
      );
    }

    const quantity = input.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException('BOM quantity must be a positive integer.');
    }

    const existing = await this.prisma.bomLink.findUnique({
      where: {
        parentId_childId: {
          parentId: parent.id,
          childId: child.id,
        },
      },
      select: {
        parentId: true,
      },
    });

    if (existing) {
      throw new BadRequestException(
        `BOM link already exists between ${parent.partNumber} and ${child.partNumber}.`,
      );
    }

    if (await this.isReachable(child.id, parent.id)) {
      throw new BadRequestException(
        'BOM link creation failed because it would introduce a cycle.',
      );
    }

    const createdLink = await this.prisma.$transaction(async (tx) => {
      const link = await tx.bomLink.create({
        data: {
          parentId: parent.id,
          childId: child.id,
          quantity,
        },
      });

      await this.writeAudit(
        tx,
        parent.id,
        'BOM_LINK_CREATED',
        `Linked child ${child.partNumber} to ${parent.partNumber}.`,
        {
          childId: child.id,
          quantity,
        },
      );

      await this.writeAudit(
        tx,
        child.id,
        'BOM_LINK_CREATED',
        `Linked as child of ${parent.partNumber}.`,
        {
          parentId: parent.id,
          quantity,
        },
      );

      return link;
    });

    return this.toBomLink(createdLink);
  }

  async updateBomLink(input: UpdateBomLinkInput): Promise<BomLink> {
    const [parent, child] = await Promise.all([
      this.requirePart(input.parentId),
      this.requirePart(input.childId),
    ]);

    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException('BOM quantity must be a positive integer.');
    }

    const existingLink = await this.prisma.bomLink.findUnique({
      where: {
        parentId_childId: {
          parentId: parent.id,
          childId: child.id,
        },
      },
    });

    if (!existingLink) {
      throw new NotFoundException(
        `No BOM link exists between ${parent.partNumber} and ${child.partNumber}.`,
      );
    }

    const updatedLink = await this.prisma.$transaction(async (tx) => {
      const link = await tx.bomLink.update({
        where: {
          parentId_childId: {
            parentId: parent.id,
            childId: child.id,
          },
        },
        data: {
          quantity: input.quantity,
        },
      });

      await this.writeAudit(
        tx,
        parent.id,
        'BOM_LINK_UPDATED',
        `Updated quantity for child ${child.partNumber} in ${parent.partNumber}.`,
        {
          childId: child.id,
          quantity: input.quantity,
        },
      );

      await this.writeAudit(
        tx,
        child.id,
        'BOM_LINK_UPDATED',
        `Updated quantity in parent ${parent.partNumber}.`,
        {
          parentId: parent.id,
          quantity: input.quantity,
        },
      );

      return link;
    });

    return this.toBomLink(updatedLink);
  }

  async removeBomLink(parentId: string, childId: string): Promise<void> {
    const [parent, child] = await Promise.all([
      this.requirePart(parentId),
      this.requirePart(childId),
    ]);

    const link = await this.prisma.bomLink.findUnique({
      where: {
        parentId_childId: {
          parentId: parent.id,
          childId: child.id,
        },
      },
      select: {
        parentId: true,
      },
    });

    if (!link) {
      throw new NotFoundException(
        `No BOM link exists between ${parent.partNumber} and ${child.partNumber}.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.bomLink.delete({
        where: {
          parentId_childId: {
            parentId: parent.id,
            childId: child.id,
          },
        },
      });

      await this.writeAudit(
        tx,
        parent.id,
        'BOM_LINK_REMOVED',
        `Removed child ${child.partNumber} from ${parent.partNumber}.`,
        {
          childId: child.id,
        },
      );

      await this.writeAudit(
        tx,
        child.id,
        'BOM_LINK_REMOVED',
        `Removed parent ${parent.partNumber}.`,
        {
          parentId: parent.id,
        },
      );
    });
  }

  async getBomTree(
    rootPartId: string,
    depth = 1,
    nodeLimit = this.maxExpandNodeLimit,
  ): Promise<BomTreeResponse> {
    await this.requirePart(rootPartId);

    if (!Number.isInteger(depth) || depth < 0) {
      throw new BadRequestException('Depth must be an integer >= 0.');
    }

    if (depth > this.maxExpandDepth) {
      throw new BadRequestException(
        `Expand limit exceeded. Maximum supported depth is ${this.maxExpandDepth}.`,
      );
    }

    if (!Number.isInteger(nodeLimit) || nodeLimit <= 0) {
      throw new BadRequestException('Node limit must be an integer > 0.');
    }

    if (nodeLimit > this.maxExpandNodeLimit) {
      throw new BadRequestException(
        `Node limit too large. Maximum supported node limit is ${this.maxExpandNodeLimit}.`,
      );
    }

    let nodeCount = 0;
    const partCache = new Map<string, Part>();
    const childLinksCache = new Map<string, BomLink[]>();

    const getPart = async (partId: string): Promise<Part> => {
      const cachedPart = partCache.get(partId);
      if (cachedPart) {
        return cachedPart;
      }

      const part = await this.requirePart(partId);
      partCache.set(partId, part);
      return part;
    };

    const getChildLinks = async (partId: string): Promise<BomLink[]> => {
      const cachedLinks = childLinksCache.get(partId);
      if (cachedLinks) {
        return cachedLinks;
      }

      const links = await this.getChildLinks(partId);
      childLinksCache.set(partId, links);
      return links;
    };

    const buildNode = async (
      partId: string,
      currentDepth: number,
      quantityFromParent: number | undefined,
      path: Set<string>,
    ): Promise<BomTreeNode> => {
      if (nodeCount >= nodeLimit) {
        throw new BadRequestException(
          `BOM expansion exceeded node limit of ${nodeLimit}. Reduce depth or load incrementally.`,
        );
      }

      nodeCount += 1;

      const part = await getPart(partId);
      const childLinks = await getChildLinks(partId);
      const children: BomTreeNode[] = [];

      if (currentDepth < depth) {
        for (const link of childLinks) {
          if (path.has(link.childId)) {
            continue;
          }

          const nextPath = new Set(path);
          nextPath.add(link.childId);

          children.push(
            await buildNode(
              link.childId,
              currentDepth + 1,
              link.quantity,
              nextPath,
            ),
          );
        }
      }

      const node: BomTreeNode = {
        part: this.toPartSummary(part),
        hasChildren: childLinks.length > 0,
        children,
      };

      if (quantityFromParent !== undefined) {
        node.quantityFromParent = quantityFromParent;
      }

      return node;
    };

    const tree = await buildNode(
      rootPartId,
      0,
      undefined,
      new Set([rootPartId]),
    );

    return {
      rootPartId,
      requestedDepth: depth,
      nodeLimit,
      nodeCount,
      tree,
    };
  }

  private async requirePart(partId: string): Promise<Part> {
    const row = await this.prisma.part.findUnique({
      where: {
        id: partId,
      },
    });

    if (!row) {
      throw new NotFoundException(`Part '${partId}' was not found.`);
    }

    return this.toPart(row);
  }

  private async getChildLinks(parentId: string): Promise<BomLink[]> {
    const rows = await this.prisma.bomLink.findMany({
      where: {
        parentId,
      },
      orderBy: {
        child: {
          partNumber: 'asc',
        },
      },
    });

    return rows.map((row) => this.toBomLink(row));
  }

  private toPartSummary(part: Part): PartSummary {
    return {
      id: part.id,
      partNumber: part.partNumber,
      name: part.name,
    };
  }

  private allocatePartId(): string {
    const id = `PART-${String(this.partIdSequence).padStart(4, '0')}`;
    this.partIdSequence += 1;
    return id;
  }

  private allocateAuditLogId(): string {
    const id = `AUD-${String(this.auditLogSequence).padStart(6, '0')}`;
    this.auditLogSequence += 1;
    return id;
  }

  private async allocatePartNumber(): Promise<string> {
    while (true) {
      const candidate = `PRT-${String(this.partNumberSequence).padStart(6, '0')}`;
      this.partNumberSequence += 1;

      const existing = await this.prisma.part.findUnique({
        where: {
          partNumber: candidate,
        },
        select: {
          id: true,
        },
      });

      if (!existing) {
        return candidate;
      }
    }
  }

  private async assertPartNumberIsAvailable(
    partNumber: string,
    excludedPartId?: string,
  ): Promise<void> {
    const existing = await this.prisma.part.findUnique({
      where: {
        partNumber,
      },
      select: {
        id: true,
      },
    });

    if (existing && existing.id !== excludedPartId) {
      throw new BadRequestException(
        `Part number '${partNumber}' already exists.`,
      );
    }
  }

  private updatePartNumberSequence(partNumber: string): void {
    const matches = /^PRT-(\d+)$/.exec(partNumber);
    if (!matches) {
      return;
    }

    const parsedValue = Number.parseInt(matches[1], 10);
    if (Number.isNaN(parsedValue)) {
      return;
    }

    this.partNumberSequence = Math.max(
      this.partNumberSequence,
      parsedValue + 1,
    );
  }

  private async isReachable(
    startPartId: string,
    targetPartId: string,
  ): Promise<boolean> {
    const stack: string[] = [startPartId];
    const visited = new Set<string>();
    const childIdsCache = new Map<string, string[]>();

    while (stack.length > 0) {
      const partId = stack.pop();
      if (!partId || visited.has(partId)) {
        continue;
      }

      if (partId === targetPartId) {
        return true;
      }

      visited.add(partId);

      let childIds = childIdsCache.get(partId);
      if (!childIds) {
        const childRows = await this.prisma.bomLink.findMany({
          where: {
            parentId: partId,
          },
          select: {
            childId: true,
          },
        });

        childIds = childRows.map((row) => row.childId);
        childIdsCache.set(partId, childIds);
      }

      for (const childId of childIds) {
        stack.push(childId);
      }
    }

    return false;
  }

  private async writeAudit(
    tx: TxClient,
    partId: string,
    action: AuditAction,
    message: string,
    metadata?: Record<string, string | number>,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        id: this.allocateAuditLogId(),
        partId,
        action: action as PrismaAuditAction,
        message,
        timestamp: new Date(),
        metadata: metadata ? (metadata as Prisma.InputJsonObject) : undefined,
      },
    });
  }

  private async initializeSequences(): Promise<void> {
    const [partRows, auditRows] = await Promise.all([
      this.prisma.part.findMany({
        select: {
          id: true,
          partNumber: true,
        },
      }),
      this.prisma.auditLog.findMany({
        select: {
          id: true,
        },
      }),
    ]);

    this.partIdSequence = this.resolveNextSequence(
      partRows.map((row) => row.id),
      /^PART-(\d+)$/,
    );
    this.auditLogSequence = this.resolveNextSequence(
      auditRows.map((row) => row.id),
      /^AUD-(\d+)$/,
    );
    this.partNumberSequence = this.resolveNextSequence(
      partRows.map((row) => row.partNumber),
      /^PRT-(\d+)$/,
    );
  }

  private resolveNextSequence(values: string[], pattern: RegExp): number {
    let max = 0;

    for (const value of values) {
      const matches = pattern.exec(value);
      if (!matches) {
        continue;
      }

      const parsed = Number.parseInt(matches[1], 10);
      if (!Number.isNaN(parsed)) {
        max = Math.max(max, parsed);
      }
    }

    return max + 1;
  }

  private rethrowMissingSchemaError(error: unknown): never {
    const prismaError = error as {
      code?: string;
      meta?: { table?: unknown };
    };

    if (prismaError.code === 'P2021') {
      const table =
        typeof prismaError.meta?.table === 'string'
          ? prismaError.meta.table
          : 'required table';
      throw new Error(
        `Database schema is not initialized (${table} is missing). Run \`pnpm run prisma:deploy\` in backend and restart the API.`,
      );
    }

    throw error;
  }

  private toPart(row: PrismaPartRecord): Part {
    return {
      id: row.id,
      partNumber: row.partNumber,
      name: row.name,
      description: row.description,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toBomLink(row: PrismaBomLinkRecord): BomLink {
    return {
      parentId: row.parentId,
      childId: row.childId,
      quantity: row.quantity,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toAuditMetadata(
    metadata: Prisma.JsonValue | null,
  ): Record<string, string | number> | undefined {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return undefined;
    }

    const record: Record<string, string | number> = {};

    for (const [key, value] of Object.entries(
      metadata as Record<string, Prisma.JsonValue>,
    )) {
      if (typeof value === 'string' || typeof value === 'number') {
        record[key] = value;
      }
    }

    return Object.keys(record).length > 0 ? record : undefined;
  }

  private async seedSampleData(): Promise<void> {
    const partIdsByKey = new Map<string, string>();

    for (const partDefinition of SEED_PARTS) {
      const existingPart = await this.prisma.part.findUnique({
        where: {
          partNumber: partDefinition.partNumber,
        },
        select: {
          id: true,
          partNumber: true,
        },
      });

      if (existingPart) {
        this.updatePartNumberSequence(existingPart.partNumber);
        partIdsByKey.set(partDefinition.key, existingPart.id);
        continue;
      }

      const createdPart = await this.createPart({
        partNumber: partDefinition.partNumber,
        name: partDefinition.name,
        description: partDefinition.description,
      });

      partIdsByKey.set(partDefinition.key, createdPart.id);
    }

    for (const linkDefinition of SEED_BOM_LINKS) {
      const parentId = partIdsByKey.get(linkDefinition.parentKey);
      const childId = partIdsByKey.get(linkDefinition.childKey);

      if (!parentId || !childId) {
        throw new Error(
          `Invalid seed BOM link: ${linkDefinition.parentKey} -> ${linkDefinition.childKey}.`,
        );
      }

      const existingLink = await this.prisma.bomLink.findUnique({
        where: {
          parentId_childId: {
            parentId,
            childId,
          },
        },
        select: {
          quantity: true,
        },
      });

      if (!existingLink) {
        await this.createBomLink({
          parentId,
          childId,
          quantity: linkDefinition.quantity,
        });
        continue;
      }

      if (existingLink.quantity !== linkDefinition.quantity) {
        await this.updateBomLink({
          parentId,
          childId,
          quantity: linkDefinition.quantity,
        });
      }
    }
  }
}
