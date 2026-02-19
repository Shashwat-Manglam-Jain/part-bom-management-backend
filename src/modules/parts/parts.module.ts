import { Module } from '@nestjs/common';
import { PartBomModule } from '../../core/part-bom/part-bom.module';
import { PartsController } from './parts.controller';
import { PartsService } from './parts.service';

@Module({
  imports: [PartBomModule],
  controllers: [PartsController],
  providers: [PartsService],
})
export class PartsModule {}
