import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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

@Injectable()
export class PartBomStoreService {
  readonly maxExpandDepth = 5;
  readonly maxExpandNodeLimit = 80;

  private readonly partsById = new Map<string, Part>();
  private readonly partIdByPartNumber = new Map<string, string>();
  private readonly childLinksByParentId = new Map<
    string,
    Map<string, BomLink>
  >();
  private readonly parentIdsByChildId = new Map<string, Set<string>>();
  private readonly auditLogsByPartId = new Map<string, AuditLog[]>();

  private partIdSequence = 1;
  private auditLogSequence = 1;
  private partNumberSequence = 1;

  constructor() {
    this.seedSampleData();
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

    this.partsById.set(part.id, part);
    this.partIdByPartNumber.set(part.partNumber, part.id);
    this.updatePartNumberSequence(part.partNumber);

    this.writeAudit(
      part.id,
      'PART_CREATED',
      `Part ${part.partNumber} was created.`,
      {
        name: part.name,
      },
    );

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
        this.partIdByPartNumber.delete(part.partNumber);
        this.partIdByPartNumber.set(normalizedPartNumber, part.id);
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

    this.partsById.set(partId, updatedPart);

    this.writeAudit(
      partId,
      'PART_UPDATED',
      `Part ${updatedPart.partNumber} was updated.`,
      {
        name: updatedPart.name,
      },
    );

    return { ...updatedPart };
  }

  searchParts(filters: PartSearchFilters): PartSummary[] {
    const byPartNumber = filters.partNumber?.trim().toLowerCase();
    const byName = filters.name?.trim().toLowerCase();
    const byAny = filters.q?.trim().toLowerCase();

    return [...this.partsById.values()]
      .filter((part) => {
        const numberMatch =
          !byPartNumber || part.partNumber.toLowerCase().includes(byPartNumber);
        const nameMatch = !byName || part.name.toLowerCase().includes(byName);
        const anyMatch =
          !byAny ||
          part.name.toLowerCase().includes(byAny) ||
          part.partNumber.toLowerCase().includes(byAny);

        return numberMatch && nameMatch && anyMatch;
      })
      .sort((left, right) => left.partNumber.localeCompare(right.partNumber))
      .map((part) => this.toPartSummary(part));
  }

  getPartDetails(partId: string): PartDetails {
    const part = this.requirePart(partId);

    const parentParts = this.getParentIds(partId)
      .map((parentId) => this.toPartSummary(this.requirePart(parentId)))
      .sort((left, right) => left.partNumber.localeCompare(right.partNumber));

    const childParts = this.getChildLinks(partId)
      .map((link) => {
        const childPart = this.requirePart(link.childId);
        const childUsage: ChildPartUsage = {
          ...this.toPartSummary(childPart),
          quantity: link.quantity,
        };

        return childUsage;
      })
      .sort((left, right) => left.partNumber.localeCompare(right.partNumber));

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

    const logs = this.auditLogsByPartId.get(partId) ?? [];
    return [...logs].sort((left, right) =>
      right.timestamp.localeCompare(left.timestamp),
    );
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

    const parentLinks = this.getOrCreateChildLinkMap(parent.id);
    if (parentLinks.has(child.id)) {
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

    parentLinks.set(child.id, link);

    const parentIds =
      this.parentIdsByChildId.get(child.id) ?? new Set<string>();
    parentIds.add(parent.id);
    this.parentIdsByChildId.set(child.id, parentIds);

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

    return { ...link };
  }

  updateBomLink(input: UpdateBomLinkInput): BomLink {
    const parent = this.requirePart(input.parentId);
    const child = this.requirePart(input.childId);

    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException('BOM quantity must be a positive integer.');
    }

    const parentLinks = this.childLinksByParentId.get(parent.id);
    if (!parentLinks) {
      throw new NotFoundException(
        `No BOM link exists between ${parent.partNumber} and ${child.partNumber}.`,
      );
    }

    const existingLink = parentLinks.get(child.id);
    if (!existingLink) {
      throw new NotFoundException(
        `No BOM link exists between ${parent.partNumber} and ${child.partNumber}.`,
      );
    }

    const updatedLink: BomLink = {
      ...existingLink,
      quantity: input.quantity,
    };

    parentLinks.set(child.id, updatedLink);

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

    return { ...updatedLink };
  }

  removeBomLink(parentId: string, childId: string): void {
    const parent = this.requirePart(parentId);
    const child = this.requirePart(childId);

    const parentLinks = this.childLinksByParentId.get(parent.id);
    if (!parentLinks || !parentLinks.has(child.id)) {
      throw new NotFoundException(
        `No BOM link exists between ${parent.partNumber} and ${child.partNumber}.`,
      );
    }

    parentLinks.delete(child.id);
    if (parentLinks.size === 0) {
      this.childLinksByParentId.delete(parent.id);
    }

    const parentIds = this.parentIdsByChildId.get(child.id);
    if (parentIds) {
      parentIds.delete(parent.id);
      if (parentIds.size === 0) {
        this.parentIdsByChildId.delete(child.id);
      }
    }

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
    const part = this.partsById.get(partId);
    if (!part) {
      throw new NotFoundException(`Part '${partId}' was not found.`);
    }

    return part;
  }

  private getChildLinks(parentId: string): BomLink[] {
    const links = [
      ...(this.childLinksByParentId.get(parentId)?.values() ?? []),
    ];

    return links.sort((left, right) => {
      const leftPart = this.requirePart(left.childId);
      const rightPart = this.requirePart(right.childId);
      return leftPart.partNumber.localeCompare(rightPart.partNumber);
    });
  }

  private getParentIds(childId: string): string[] {
    return [...(this.parentIdsByChildId.get(childId) ?? [])];
  }

  private toPartSummary(part: Part): PartSummary {
    return {
      id: part.id,
      partNumber: part.partNumber,
      name: part.name,
    };
  }

  private getOrCreateChildLinkMap(parentId: string): Map<string, BomLink> {
    const existing = this.childLinksByParentId.get(parentId);
    if (existing) {
      return existing;
    }

    const next = new Map<string, BomLink>();
    this.childLinksByParentId.set(parentId, next);
    return next;
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

      if (!this.partIdByPartNumber.has(candidate)) {
        return candidate;
      }
    }
  }

  private assertPartNumberIsAvailable(partNumber: string): void {
    if (this.partIdByPartNumber.has(partNumber)) {
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

      const childLinks = this.childLinksByParentId.get(partId);
      if (!childLinks) {
        continue;
      }

      for (const childId of childLinks.keys()) {
        stack.push(childId);
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

    const existingLogs = this.auditLogsByPartId.get(partId) ?? [];
    existingLogs.push(log);
    this.auditLogsByPartId.set(partId, existingLogs);
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
