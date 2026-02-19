import { Module } from '@nestjs/common';
import { PartBomStoreService } from './part-bom-store.service';

@Module({
  providers: [PartBomStoreService],
  exports: [PartBomStoreService],
})
export class PartBomModule {}
