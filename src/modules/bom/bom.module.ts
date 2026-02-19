import { Module } from '@nestjs/common';
import { PartBomModule } from '../../core/part-bom/part-bom.module';
import { BomController } from './bom.controller';
import { BomService } from './bom.service';

@Module({
  imports: [PartBomModule],
  controllers: [BomController],
  providers: [BomService],
})
export class BomModule {}
