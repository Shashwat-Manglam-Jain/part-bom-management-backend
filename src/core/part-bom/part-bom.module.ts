import { Module } from '@nestjs/common';
import { PartBomStoreService } from './part-bom-store.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  providers: [PrismaService, PartBomStoreService],
  exports: [PartBomStoreService],
})
export class PartBomModule {}
