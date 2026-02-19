import { BadRequestException, Injectable } from '@nestjs/common';
import { PartBomStoreService } from '../../core/part-bom/part-bom-store.service';
import { PartSearchFilters } from '../../core/part-bom/part-bom.models';
import { CreatePartDto } from './dto/create-part.dto';
import { UpdatePartDto } from './dto/update-part.dto';

@Injectable()
export class PartsService {
  constructor(private readonly store: PartBomStoreService) {}

  searchParts(filters: PartSearchFilters) {
    return this.store.searchParts(filters);
  }

  getPartDetails(partId: string) {
    return this.store.getPartDetails(partId);
  }

  getPartAuditLogs(partId: string) {
    return this.store.getPartAuditLogs(partId);
  }

  createPart(payload: CreatePartDto) {
    if (!payload.name || !payload.name.trim()) {
      throw new BadRequestException('Part name is required.');
    }

    return this.store.createPart({
      partNumber: payload.partNumber,
      name: payload.name,
      description: payload.description,
    });
  }

  updatePart(partId: string, payload: UpdatePartDto) {
    if (
      payload.name === undefined &&
      payload.description === undefined &&
      payload.partNumber === undefined
    ) {
      throw new BadRequestException(
        'At least one field must be provided for update.',
      );
    }

    return this.store.updatePart(partId, {
      partNumber: payload.partNumber,
      name: payload.name,
      description: payload.description,
    });
  }
}
