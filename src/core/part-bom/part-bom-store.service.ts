import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
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

interface PartRow {
  id: string;
  part_number: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

interface BomLinkRow {
  parentId: string;
  childId: string;
  quantity: number;
  createdAt: string;
}

interface AuditLogRow {
  id: string;
  partId: string;
  action: AuditAction;
  message: string;
  timestamp: string;
  metadata: string | null;
}

@Injectable()
export class PartBomStoreService implements OnModuleDestroy {
  readonly maxExpandDepth = 5;
  readonly maxExpandNodeLimit = 80;

  private readonly db: BetterSqlite3.Database;

  private partIdSequence = 1;
  private auditLogSequence = 1;
  private partNumberSequence = 1;

  constructor() {
    const isVercel = process.env.VERCEL === '1';
    const defaultDatabasePath = isVercel
      ? '/tmp/part-bom.sqlite'
      : join(process.cwd(), 'data', 'part-bom.sqlite');
    const dbPath = process.env.DATABASE_PATH?.trim() || defaultDatabasePath;

    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }

    this.db = new BetterSqlite3(dbPath);
    this.db.pragma('foreign_keys = ON');

    if (dbPath !== ':memory:' && !isVercel) {
      this.db.pragma('journal_mode = WAL');
    }

    this.initializeSchema();
    this.initializeSequences();

    const shouldSeed =
      (process.env.SEED_SAMPLE_DATA ?? 'true').toLowerCase() !== 'false';
    if (shouldSeed && this.getPartsCount() === 0) {
      this.seedSampleData();
    }
  }

  onModuleDestroy() {
    this.db.close();
  }

  createPart(input: CreatePartInput): Part {
    const normalizedName = input.name.trim();
    if (!normalizedName) {
      throw new BadRequestException('Part name is required.');
    }

    const requestedPartNumber = input.partNumber?.trim().toUpperCase();
    const partNumber =
      requestedPartNumber && requestedPartNumber.length > 0
        ? requestedPartNumber
        : this.allocatePartNumber();

    this.assertPartNumberIsAvailable(partNumber);

    const now = this.getTimestamp();
    const part: Part = {
      id: this.allocatePartId(),
      partNumber,
      name: normalizedName,
      description: input.description?.trim() ?? '',
      createdAt: now,
      updatedAt: now,
    };

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO parts (
            id,
            part_number,
            name,
            description,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          part.id,
          part.partNumber,
          part.name,
          part.description,
          part.createdAt,
          part.updatedAt,
        );

      this.updatePartNumberSequence(part.partNumber);

      this.writeAudit(
        part.id,
        'PART_CREATED',
        `Part ${part.partNumber} was created.`,
        {
          name: part.name,
        },
      );
    })();

    return { ...part };
  }

  updatePart(partId: string, input: UpdatePartInput): Part {
    const part = this.requirePart(partId);

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
        this.assertPartNumberIsAvailable(normalizedPartNumber);
        this.updatePartNumberSequence(normalizedPartNumber);
      }

      nextPartNumber = normalizedPartNumber;
    }

    const updatedPart: Part = {
      ...part,
      partNumber: nextPartNumber,
      name: nextName,
      description: nextDescription,
      updatedAt: this.getTimestamp(),
    };

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE parts
            SET part_number = ?,
                name = ?,
                description = ?,
                updated_at = ?
          WHERE id = ?`,
        )
        .run(
          updatedPart.partNumber,
          updatedPart.name,
          updatedPart.description,
          updatedPart.updatedAt,
          partId,
        );

      this.writeAudit(
        partId,
        'PART_UPDATED',
        `Part ${updatedPart.partNumber} was updated.`,
        {
          name: updatedPart.name,
        },
      );
    })();

    return { ...updatedPart };
  }

  searchParts(filters: PartSearchFilters): PartSummary[] {
    const byPartNumber = filters.partNumber?.trim().toLowerCase();
    const byName = filters.name?.trim().toLowerCase();
    const byAny = filters.q?.trim().toLowerCase();

    const whereClauses: string[] = [];
    const params: string[] = [];

    if (byPartNumber) {
      whereClauses.push('LOWER(part_number) LIKE ?');
      params.push(`%${byPartNumber}%`);
    }

    if (byName) {
      whereClauses.push('LOWER(name) LIKE ?');
      params.push(`%${byName}%`);
    }

    if (byAny) {
      whereClauses.push('(LOWER(name) LIKE ? OR LOWER(part_number) LIKE ?)');
      params.push(`%${byAny}%`, `%${byAny}%`);
    }

    const whereQuery =
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const rows = this.db
      .prepare(
        `SELECT id, part_number AS partNumber, name
         FROM parts
         ${whereQuery}
         ORDER BY part_number ASC`,
      )
      .all(...params) as PartSummary[];

    return rows.map((row) => ({
      id: row.id,
      partNumber: row.partNumber,
      name: row.name,
    }));
  }

  getPartDetails(partId: string): PartDetails {
    const part = this.requirePart(partId);

    const parentParts = this.db
      .prepare(
        `SELECT p.id, p.part_number AS partNumber, p.name
         FROM bom_links bl
         INNER JOIN parts p ON p.id = bl.parent_id
         WHERE bl.child_id = ?
         ORDER BY p.part_number ASC`,
      )
      .all(partId) as PartSummary[];

    const childParts = this.db
      .prepare(
        `SELECT p.id, p.part_number AS partNumber, p.name, bl.quantity
         FROM bom_links bl
         INNER JOIN parts p ON p.id = bl.child_id
         WHERE bl.parent_id = ?
         ORDER BY p.part_number ASC`,
      )
      .all(partId) as ChildPartUsage[];

    return {
      ...part,
      parentCount: parentParts.length,
      childCount: childParts.length,
      parentParts,
      childParts,
    };
  }

  getPartAuditLogs(partId: string): AuditLog[] {
    this.requirePart(partId);

    const rows = this.db
      .prepare(
        `SELECT
          id,
          part_id AS partId,
          action,
          message,
          timestamp,
          metadata
         FROM audit_logs
         WHERE part_id = ?
         ORDER BY timestamp DESC`,
      )
      .all(partId) as AuditLogRow[];

    return rows.map((row) => ({
      id: row.id,
      partId: row.partId,
      action: row.action,
      message: row.message,
      timestamp: row.timestamp,
      metadata: row.metadata
        ? (JSON.parse(row.metadata) as Record<string, string | number>)
        : undefined,
    }));
  }

  createBomLink(input: CreateBomLinkInput): BomLink {
    const parent = this.requirePart(input.parentId);
    const child = this.requirePart(input.childId);

    if (parent.id === child.id) {
      throw new BadRequestException(
        'A part cannot be linked to itself in BOM.',
      );
    }

    const quantity = input.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException('BOM quantity must be a positive integer.');
    }

    const existing = this.db
      .prepare(
        'SELECT 1 AS found FROM bom_links WHERE parent_id = ? AND child_id = ?',
      )
      .get(parent.id, child.id) as { found: number } | undefined;

    if (existing) {
      throw new BadRequestException(
        `BOM link already exists between ${parent.partNumber} and ${child.partNumber}.`,
      );
    }

    if (this.isReachable(child.id, parent.id)) {
      throw new BadRequestException(
        'BOM link creation failed because it would introduce a cycle.',
      );
    }

    const link: BomLink = {
      parentId: parent.id,
      childId: child.id,
      quantity,
      createdAt: this.getTimestamp(),
    };

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO bom_links (parent_id, child_id, quantity, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(link.parentId, link.childId, link.quantity, link.createdAt);

      this.writeAudit(
        parent.id,
        'BOM_LINK_CREATED',
        `Linked child ${child.partNumber} to ${parent.partNumber}.`,
        {
          childId: child.id,
          quantity,
        },
      );

      this.writeAudit(
        child.id,
        'BOM_LINK_CREATED',
        `Linked as child of ${parent.partNumber}.`,
        {
          parentId: parent.id,
          quantity,
        },
      );
    })();

    return { ...link };
  }

  updateBomLink(input: UpdateBomLinkInput): BomLink {
    const parent = this.requirePart(input.parentId);
    const child = this.requirePart(input.childId);

    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException('BOM quantity must be a positive integer.');
    }

    const existingLink = this.db
      .prepare(
        `SELECT created_at AS createdAt
         FROM bom_links
         WHERE parent_id = ? AND child_id = ?`,
      )
      .get(parent.id, child.id) as { createdAt: string } | undefined;

    if (!existingLink) {
      throw new NotFoundException(
        `No BOM link exists between ${parent.partNumber} and ${child.partNumber}.`,
      );
    }

    const updatedLink: BomLink = {
      parentId: parent.id,
      childId: child.id,
      quantity: input.quantity,
      createdAt: existingLink.createdAt,
    };

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE bom_links
           SET quantity = ?
           WHERE parent_id = ? AND child_id = ?`,
        )
        .run(input.quantity, parent.id, child.id);

      this.writeAudit(
        parent.id,
        'BOM_LINK_UPDATED',
        `Updated quantity for child ${child.partNumber} in ${parent.partNumber}.`,
        {
          childId: child.id,
          quantity: input.quantity,
        },
      );

      this.writeAudit(
        child.id,
        'BOM_LINK_UPDATED',
        `Updated quantity in parent ${parent.partNumber}.`,
        {
          parentId: parent.id,
          quantity: input.quantity,
        },
      );
    })();

    return { ...updatedLink };
  }

  removeBomLink(parentId: string, childId: string): void {
    const parent = this.requirePart(parentId);
    const child = this.requirePart(childId);

    const link = this.db
      .prepare(
        'SELECT 1 AS found FROM bom_links WHERE parent_id = ? AND child_id = ?',
      )
      .get(parent.id, child.id) as { found: number } | undefined;

    if (!link) {
      throw new NotFoundException(
        `No BOM link exists between ${parent.partNumber} and ${child.partNumber}.`,
      );
    }

    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM bom_links WHERE parent_id = ? AND child_id = ?')
        .run(parent.id, child.id);

      this.writeAudit(
        parent.id,
        'BOM_LINK_REMOVED',
        `Removed child ${child.partNumber} from ${parent.partNumber}.`,
        {
          childId: child.id,
        },
      );

      this.writeAudit(
        child.id,
        'BOM_LINK_REMOVED',
        `Removed parent ${parent.partNumber}.`,
        {
          parentId: parent.id,
        },
      );
    })();
  }

  getBomTree(
    rootPartId: string,
    depth = 1,
    nodeLimit = this.maxExpandNodeLimit,
  ): BomTreeResponse {
    this.requirePart(rootPartId);

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

    const buildNode = (
      partId: string,
      currentDepth: number,
      quantityFromParent: number | undefined,
      path: Set<string>,
    ): BomTreeNode => {
      if (nodeCount >= nodeLimit) {
        throw new BadRequestException(
          `BOM expansion exceeded node limit of ${nodeLimit}. Reduce depth or load incrementally.`,
        );
      }

      nodeCount += 1;

      const part = this.requirePart(partId);
      const childLinks = this.getChildLinks(partId);
      const children: BomTreeNode[] = [];

      if (currentDepth < depth) {
        for (const link of childLinks) {
          if (path.has(link.childId)) {
            continue;
          }

          const nextPath = new Set(path);
          nextPath.add(link.childId);

          children.push(
            buildNode(link.childId, currentDepth + 1, link.quantity, nextPath),
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

    const tree = buildNode(rootPartId, 0, undefined, new Set([rootPartId]));

    return {
      rootPartId,
      requestedDepth: depth,
      nodeLimit,
      nodeCount,
      tree,
    };
  }

  private requirePart(partId: string): Part {
    const row = this.db
      .prepare(
        `SELECT id, part_number, name, description, created_at, updated_at
         FROM parts
         WHERE id = ?`,
      )
      .get(partId) as PartRow | undefined;

    if (!row) {
      throw new NotFoundException(`Part '${partId}' was not found.`);
    }

    return this.toPart(row);
  }

  private getChildLinks(parentId: string): BomLink[] {
    const rows = this.db
      .prepare(
        `SELECT
          bl.parent_id AS parentId,
          bl.child_id AS childId,
          bl.quantity,
          bl.created_at AS createdAt
         FROM bom_links bl
         INNER JOIN parts p ON p.id = bl.child_id
         WHERE bl.parent_id = ?
         ORDER BY p.part_number ASC`,
      )
      .all(parentId) as BomLinkRow[];

    return rows.map((row) => ({
      parentId: row.parentId,
      childId: row.childId,
      quantity: row.quantity,
      createdAt: row.createdAt,
    }));
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

  private allocatePartNumber(): string {
    while (true) {
      const candidate = `PRT-${String(this.partNumberSequence).padStart(6, '0')}`;
      this.partNumberSequence += 1;

      const existing = this.db
        .prepare('SELECT id FROM parts WHERE part_number = ?')
        .get(candidate) as { id: string } | undefined;

      if (!existing) {
        return candidate;
      }
    }
  }

  private assertPartNumberIsAvailable(partNumber: string): void {
    const existing = this.db
      .prepare('SELECT id FROM parts WHERE part_number = ?')
      .get(partNumber) as { id: string } | undefined;

    if (existing) {
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

  private getTimestamp(): string {
    return new Date().toISOString();
  }

  private isReachable(startPartId: string, targetPartId: string): boolean {
    const stack: string[] = [startPartId];
    const visited = new Set<string>();

    while (stack.length > 0) {
      const partId = stack.pop();
      if (!partId || visited.has(partId)) {
        continue;
      }

      if (partId === targetPartId) {
        return true;
      }

      visited.add(partId);

      const childRows = this.db
        .prepare(
          'SELECT child_id AS childId FROM bom_links WHERE parent_id = ?',
        )
        .all(partId) as Array<{ childId: string }>;

      for (const row of childRows) {
        stack.push(row.childId);
      }
    }

    return false;
  }

  private writeAudit(
    partId: string,
    action: AuditAction,
    message: string,
    metadata?: Record<string, string | number>,
  ): void {
    const log: AuditLog = {
      id: this.allocateAuditLogId(),
      partId,
      action,
      message,
      timestamp: this.getTimestamp(),
      metadata,
    };

    this.db
      .prepare(
        `INSERT INTO audit_logs (id, part_id, action, message, timestamp, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        log.id,
        log.partId,
        log.action,
        log.message,
        log.timestamp,
        log.metadata ? JSON.stringify(log.metadata) : null,
      );
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS parts (
        id TEXT PRIMARY KEY,
        part_number TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bom_links (
        parent_id TEXT NOT NULL,
        child_id TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (parent_id, child_id),
        FOREIGN KEY (parent_id) REFERENCES parts(id) ON DELETE CASCADE,
        FOREIGN KEY (child_id) REFERENCES parts(id) ON DELETE CASCADE,
        CHECK (quantity > 0)
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        part_id TEXT NOT NULL,
        action TEXT NOT NULL,
        message TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        metadata TEXT,
        FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_parts_part_number ON parts(part_number);
      CREATE INDEX IF NOT EXISTS idx_bom_links_parent ON bom_links(parent_id);
      CREATE INDEX IF NOT EXISTS idx_bom_links_child ON bom_links(child_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_part_timestamp ON audit_logs(part_id, timestamp DESC);
    `);
  }

  private initializeSequences(): void {
    const partRows = this.db.prepare('SELECT id FROM parts').all() as Array<{
      id: string;
    }>;
    const auditRows = this.db
      .prepare('SELECT id FROM audit_logs')
      .all() as Array<{ id: string }>;
    const partNumberRows = this.db
      .prepare('SELECT part_number AS partNumber FROM parts')
      .all() as Array<{ partNumber: string }>;

    this.partIdSequence = this.resolveNextSequence(
      partRows.map((row) => row.id),
      /^PART-(\d+)$/,
    );
    this.auditLogSequence = this.resolveNextSequence(
      auditRows.map((row) => row.id),
      /^AUD-(\d+)$/,
    );
    this.partNumberSequence = this.resolveNextSequence(
      partNumberRows.map((row) => row.partNumber),
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

  private getPartsCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM parts')
      .get() as {
      count: number;
    };
    return row.count;
  }

  private toPart(row: PartRow): Part {
    return {
      id: row.id,
      partNumber: row.part_number,
      name: row.name,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private seedSampleData(): void {
    const parts = {
      root: this.createPart({
        partNumber: 'PRT-000001',
        name: 'Autonomous Cart Assembly',
        description: 'Root product assembly used for startup sample data.',
      }),
      mechanical: this.createPart({
        partNumber: 'PRT-000002',
        name: 'Mechanical Module',
      }),
      electrical: this.createPart({
        partNumber: 'PRT-000003',
        name: 'Electrical Module',
      }),
      controls: this.createPart({
        partNumber: 'PRT-000004',
        name: 'Controls Module',
      }),
      basePlate: this.createPart({
        partNumber: 'PRT-000005',
        name: 'Base Plate',
      }),
      suspension: this.createPart({
        partNumber: 'PRT-000006',
        name: 'Suspension Kit',
      }),
      wheelSet: this.createPart({
        partNumber: 'PRT-000007',
        name: 'Wheel Set',
      }),
      harness: this.createPart({
        partNumber: 'PRT-000008',
        name: 'Primary Harness',
      }),
      batteryPack: this.createPart({
        partNumber: 'PRT-000009',
        name: 'Battery Pack',
      }),
      safetyRelay: this.createPart({
        partNumber: 'PRT-000010',
        name: 'Safety Relay',
      }),
      controllerBoard: this.createPart({
        partNumber: 'PRT-000011',
        name: 'Controller Board',
      }),
      operatorPanel: this.createPart({
        partNumber: 'PRT-000012',
        name: 'Operator Panel',
      }),
      coolingModule: this.createPart({
        partNumber: 'PRT-000013',
        name: 'Cooling Module',
      }),
      frontLeftWheel: this.createPart({
        partNumber: 'PRT-000014',
        name: 'Front Left Wheel',
      }),
      frontRightWheel: this.createPart({
        partNumber: 'PRT-000015',
        name: 'Front Right Wheel',
      }),
      rearLeftWheel: this.createPart({
        partNumber: 'PRT-000016',
        name: 'Rear Left Wheel',
      }),
      rearRightWheel: this.createPart({
        partNumber: 'PRT-000017',
        name: 'Rear Right Wheel',
      }),
      lidar: this.createPart({
        partNumber: 'PRT-000018',
        name: 'LiDAR Sensor',
      }),
      imu: this.createPart({
        partNumber: 'PRT-000019',
        name: 'IMU Sensor',
      }),
      cpuModule: this.createPart({
        partNumber: 'PRT-000020',
        name: 'CPU Module',
      }),
      ioModule: this.createPart({
        partNumber: 'PRT-000021',
        name: 'I/O Module',
      }),
    };

    this.createBomLink({
      parentId: parts.root.id,
      childId: parts.mechanical.id,
      quantity: 1,
    });
    this.createBomLink({
      parentId: parts.root.id,
      childId: parts.electrical.id,
      quantity: 1,
    });
    this.createBomLink({
      parentId: parts.root.id,
      childId: parts.controls.id,
      quantity: 1,
    });

    this.createBomLink({
      parentId: parts.mechanical.id,
      childId: parts.basePlate.id,
      quantity: 1,
    });
    this.createBomLink({
      parentId: parts.mechanical.id,
      childId: parts.suspension.id,
      quantity: 1,
    });
    this.createBomLink({
      parentId: parts.mechanical.id,
      childId: parts.wheelSet.id,
      quantity: 1,
    });

    this.createBomLink({
      parentId: parts.wheelSet.id,
      childId: parts.frontLeftWheel.id,
      quantity: 1,
    });
    this.createBomLink({
      parentId: parts.wheelSet.id,
      childId: parts.frontRightWheel.id,
      quantity: 1,
    });
    this.createBomLink({
      parentId: parts.wheelSet.id,
      childId: parts.rearLeftWheel.id,
      quantity: 1,
    });
    this.createBomLink({
      parentId: parts.wheelSet.id,
      childId: parts.rearRightWheel.id,
      quantity: 1,
    });

    this.createBomLink({
      parentId: parts.electrical.id,
      childId: parts.harness.id,
      quantity: 1,
    });
    this.createBomLink({
      parentId: parts.electrical.id,
      childId: parts.batteryPack.id,
      quantity: 1,
    });
    this.createBomLink({
      parentId: parts.electrical.id,
      childId: parts.safetyRelay.id,
      quantity: 1,
    });

    this.createBomLink({
      parentId: parts.controls.id,
      childId: parts.controllerBoard.id,
      quantity: 1,
    });
    this.createBomLink({
      parentId: parts.controls.id,
      childId: parts.operatorPanel.id,
      quantity: 1,
    });
    this.createBomLink({
      parentId: parts.controls.id,
      childId: parts.coolingModule.id,
      quantity: 1,
    });

    this.createBomLink({
      parentId: parts.controllerBoard.id,
      childId: parts.lidar.id,
      quantity: 1,
    });
    this.createBomLink({
      parentId: parts.controllerBoard.id,
      childId: parts.imu.id,
      quantity: 1,
    });
    this.createBomLink({
      parentId: parts.controllerBoard.id,
      childId: parts.cpuModule.id,
      quantity: 1,
    });
    this.createBomLink({
      parentId: parts.controllerBoard.id,
      childId: parts.ioModule.id,
      quantity: 1,
    });
  }
}
