import { BadRequestException, Injectable } from '@nestjs/common';
import { PartBomStoreService } from '../../core/part-bom/part-bom-store.service';
import { CreateBomLinkDto } from './dto/create-bom-link.dto';
import { UpdateBomLinkDto } from './dto/update-bom-link.dto';

@Injectable()
export class BomService {
  constructor(private readonly store: PartBomStoreService) {}

  getBomTree(rootPartId: string, depthQuery?: string, nodeLimitQuery?: string) {
    const depth = this.parseDepth(depthQuery);
    const nodeLimit = this.parseNodeLimit(nodeLimitQuery);

    return this.store.getBomTree(rootPartId, depth, nodeLimit);
  }

  createBomLink(payload: CreateBomLinkDto) {
    if (!payload.parentId || !payload.childId) {
      throw new BadRequestException('Both parentId and childId are required.');
    }

    return this.store.createBomLink({
      parentId: payload.parentId,
      childId: payload.childId,
      quantity: payload.quantity,
    });
  }

  updateBomLink(payload: UpdateBomLinkDto) {
    if (!payload.parentId || !payload.childId) {
      throw new BadRequestException('Both parentId and childId are required.');
    }

    if (payload.quantity === undefined) {
      throw new BadRequestException('Quantity is required.');
    }

    return this.store.updateBomLink({
      parentId: payload.parentId,
      childId: payload.childId,
      quantity: payload.quantity,
    });
  }

  removeBomLink(parentId: string, childId: string) {
    this.store.removeBomLink(parentId, childId);

    return {
      message: 'BOM link removed successfully.',
      parentId,
      childId,
    };
  }

  private parseDepth(depthQuery?: string): number {
    if (!depthQuery) {
      return 1;
    }

    if (depthQuery.toLowerCase() === 'all') {
      return this.store.maxExpandDepth;
    }

    const parsed = Number.parseInt(depthQuery, 10);
    if (Number.isNaN(parsed)) {
      throw new BadRequestException('Depth must be a number or "all".');
    }

    return parsed;
  }

  private parseNodeLimit(nodeLimitQuery?: string): number {
    if (!nodeLimitQuery) {
      return this.store.maxExpandNodeLimit;
    }

    const parsed = Number.parseInt(nodeLimitQuery, 10);
    if (Number.isNaN(parsed)) {
      throw new BadRequestException('nodeLimit must be a number.');
    }

    return parsed;
  }
}
