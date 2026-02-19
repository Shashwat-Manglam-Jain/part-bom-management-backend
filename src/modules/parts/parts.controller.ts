import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { CreatePartDto } from './dto/create-part.dto';
import { UpdatePartDto } from './dto/update-part.dto';
import { PartsService } from './parts.service';

@Controller('parts')
export class PartsController {
  constructor(private readonly partsService: PartsService) {}

  @Get()
  searchParts(
    @Query('partNumber') partNumber?: string,
    @Query('name') name?: string,
    @Query('q') q?: string,
  ) {
    return this.partsService.searchParts({ partNumber, name, q });
  }

  @Post()
  createPart(@Body() payload: CreatePartDto) {
    return this.partsService.createPart(payload);
  }

  @Put(':partId')
  updatePart(@Param('partId') partId: string, @Body() payload: UpdatePartDto) {
    return this.partsService.updatePart(partId, payload);
  }

  @Get(':partId/audit-logs')
  getPartAuditLogs(@Param('partId') partId: string) {
    return this.partsService.getPartAuditLogs(partId);
  }

  @Get(':partId')
  getPartDetails(@Param('partId') partId: string) {
    return this.partsService.getPartDetails(partId);
  }
}
