import { Module } from '@nestjs/common';
import { BomModule } from './modules/bom/bom.module';
import { HealthModule } from './modules/health/health.module';
import { PartsModule } from './modules/parts/parts.module';

@Module({
  imports: [HealthModule, PartsModule, BomModule],
})
export class AppModule {}
