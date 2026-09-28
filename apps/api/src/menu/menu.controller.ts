import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { MenuItem } from '@prisma/client';
import type { MenuCategoryDto, MenuItemDto } from '@nhs/types';
import { z } from 'zod';
import { actorId, Allow, CurrentPrincipal, type Principal } from '../auth/principal';
import { AuditService } from '../common/audit.service';
import { ZodPipe } from '../common/zod.pipe';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../prisma/prisma.service';

export function toMenuItemDto(m: MenuItem): MenuItemDto {
  return {
    id: m.id,
    code: m.code,
    name: m.name,
    categoryId: m.categoryId,
    price: m.price,
    tags: m.tags,
    imageUrl: m.imageUrl,
    available: m.available,
    station: m.station,
    taxGroup: m.taxGroup,
  };
}

const ItemSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(120),
  categoryId: z.string().uuid(),
  price: z.number().int().min(0),
  tags: z.array(z.string()).default([]),
  imageUrl: z.string().url().nullable().optional(),
  station: z.string().min(1),
  taxGroup: z.string().min(1),
});
const AvailabilitySchema = z.object({ available: z.boolean() });

@Controller('menu')
export class MenuController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Query('available') available?: string): Promise<{ categories: MenuCategoryDto[]; items: MenuItemDto[] }> {
    const [categories, items] = await Promise.all([
      this.prisma.menuCategory.findMany({ orderBy: { sort: 'asc' } }),
      this.prisma.menuItem.findMany({
        where: available === 'true' ? { available: true } : undefined,
        orderBy: [{ sort: 'asc' }, { name: 'asc' }],
      }),
    ]);
    return { categories: categories.map((c) => ({ id: c.id, name: c.name, sort: c.sort })), items: items.map(toMenuItemDto) };
  }

  @Allow('MANAGER')
  @Post()
  async create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(ItemSchema)) body: z.infer<typeof ItemSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.menuItem.create({ data: body });
      await this.audit.record(tx, { actorId: actorId(p), action: 'menu.create', entity: 'menu_item', entityId: item.id, after: item });
      return toMenuItemDto(item);
    });
  }

  @Allow('MANAGER')
  @Patch(':id')
  async update(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ItemSchema.partial())) body: Partial<z.infer<typeof ItemSchema>>,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.menuItem.findUniqueOrThrow({ where: { id } });
      const item = await tx.menuItem.update({ where: { id }, data: body });
      // Sửa giá là thao tác nhạy cảm; giá các order cũ không đổi vì order_items lưu giá tại thời điểm gọi.
      await this.audit.record(tx, { actorId: actorId(p), action: 'menu.update', entity: 'menu_item', entityId: id, before, after: item });
      return toMenuItemDto(item);
    });
  }

  /** Báo hết / bán lại: tablet khóa món ngay qua sự kiện menu.soldout. */
  @Allow('MANAGER', 'KITCHEN', 'KDS')
  @Patch(':id/availability')
  async availability(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(AvailabilitySchema)) body: z.infer<typeof AvailabilitySchema>,
  ) {
    const item = await this.prisma.$transaction(async (tx) => {
      const item = await tx.menuItem.update({ where: { id }, data: { available: body.available } });
      await this.events.append(tx, body.available ? 'menu.available' : 'menu.soldout', 'menu_item', id, {
        menuItemId: id,
        name: item.name,
        by: actorId(p),
      });
      return item;
    });
    this.events.wake();
    return toMenuItemDto(item);
  }
}
