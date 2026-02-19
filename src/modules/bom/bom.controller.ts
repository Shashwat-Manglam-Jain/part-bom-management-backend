import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CreateBomLinkDto } from './dto/create-bom-link.dto';
import { BomService } from './bom.service';
import { UpdateBomLinkDto } from './dto/update-bom-link.dto';

@Controller('bom')
export class BomController {
  constructor(private readonly bomService: BomService) {}

  @Get(':rootPartId')
  getBomTree(
    @Param('rootPartId') rootPartId: string,
    @Query('depth') depth?: string,
    @Query('nodeLimit') nodeLimit?: string,
  ) {
    return this.bomService.getBomTree(rootPartId, depth, nodeLimit);
  }

  @Post('links')
  createBomLink(@Body() payload: CreateBomLinkDto) {
    return this.bomService.createBomLink(payload);
  }

  @Put('links')
  updateBomLink(@Body() payload: UpdateBomLinkDto) {
    return this.bomService.updateBomLink(payload);
  }

  @Delete('links/:parentId/:childId')
  removeBomLink(
    @Param('parentId') parentId: string,
    @Param('childId') childId: string,
  ) {
    return this.bomService.removeBomLink(parentId, childId);
  }
}
