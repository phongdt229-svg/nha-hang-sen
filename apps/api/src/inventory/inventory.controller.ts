import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Allow, Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from './inventory.service';
import { EventsService } from '../events/events.service';
import { AuditService } from '../common/audit.service';
import { Decimal } from '@prisma/client/runtime/library';

const RecipeSchema = z.object({
  ingredients: z.array(
    z.object({
      ingredientId: z.string().uuid(),
      qty: z.number().min(0.1),
      wastePercent: z.number().min(0).default(0),
    }),
  ),
});

const ReceiveStockSchema = z.object({
  ingredientId: z.string().uuid(),
  qty: z.number().min(0.1),
  unitCost: z.number().min(0),
  lotNumber: z.string().optional(),
});

const AdjustStockSchema = z.object({
  ingredientId: z.string().uuid(),
  type: z.enum(['HỦY', 'CHUYỂN', 'ĐIỀU_CHỈNH']),
  qty: z.number().min(0),
  reason: z.string().max(200).optional(),
});

@Controller()
export class InventoryController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly events: EventsService,
    private readonly audit: AuditService,
  ) {}

  // ============ INGREDIENTS ============

  @Allow('STOREKEEPER', 'HEAD_CHEF', 'MANAGER')
  @Get('ingredients')
  async listIngredients() {
    return this.inventory.listIngredients();
  }

  @Allow('STOREKEEPER', 'HEAD_CHEF', 'MANAGER')
  @Get('ingredients/:id/stock')
  async getStock(@Param('id') ingredientId: string) {
    const ingredient = await this.inventory.getIngredient(ingredientId);
    const currentStock = await this.inventory.getCurrentStock(ingredientId);
    return {
      ingredientId,
      name: ingredient.name,
      unit: ingredient.unit,
      currentStock: currentStock.toNumber(),
      minStock: ingredient.minStock.toNumber(),
    };
  }

  // ============ RECIPES ============

  @Allow('HEAD_CHEF', 'MANAGER')
  @Get('menu/:id/recipe')
  async getRecipe(@Param('id') menuItemId: string) {
    return this.prisma.menuItem.findUniqueOrThrow({
      where: { id: menuItemId },
      include: { recipeLines: { include: { ingredient: true } } },
    });
  }

  @Allow('HEAD_CHEF', 'MANAGER')
  @Post('menu/:id/recipe')
  async setRecipe(
    @Param('id') menuItemId: string,
    @Body(new ZodPipe(RecipeSchema)) body: z.infer<typeof RecipeSchema>,
    @Principal() principal: any,
  ) {
    await this.prisma.$transaction(async (tx) => {
      // Xóa công thức cũ
      await tx.recipeLine.deleteMany({ where: { menuItemId } });

      // Thêm công thức mới
      await tx.recipeLine.createMany({
        data: body.ingredients.map((i) => ({
          menuItemId,
          ingredientId: i.ingredientId,
          qty: new Decimal(i.qty),
          wastePercent: new Decimal(i.wastePercent),
          unit: (await this.inventory.getIngredient(i.ingredientId)).unit,
        })),
      });

      // Audit
      await this.audit.record(tx, {
        actorId: principal.userId,
        action: 'SET_RECIPE',
        entity: 'MenuItem',
        entityId: menuItemId,
        after: { lines: body.ingredients },
      });

      // Event
      await this.events.append(tx, 'menu.recipe_changed', 'MenuItem', menuItemId, {
        lines: body.ingredients.length,
      });
    });

    return { ok: true };
  }

  // ============ STOCK MOVEMENT ============

  @Allow('STOREKEEPER')
  @Post('stock/receive')
  async receiveStock(
    @Body(new ZodPipe(ReceiveStockSchema)) body: z.infer<typeof ReceiveStockSchema>,
    @Principal() principal: any,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const receipt = await tx.goodsReceipt.create({
        data: { code: `GR-${Date.now()}` },
      });

      const movement = await this.inventory.receiveStock(tx, {
        ingredientId: body.ingredientId,
        qty: new Decimal(body.qty),
        unitCost: new Decimal(body.unitCost),
        lotNumber: body.lotNumber,
        refId: receipt.id,
        createdBy: principal.userId,
      });

      // Tính lại availability
      await this.inventory.recomputeMenuAvailability(tx, body.ingredientId);

      // Audit
      await this.audit.record(tx, {
        actorId: principal.userId,
        action: 'RECEIVE_STOCK',
        entity: 'Ingredient',
        entityId: body.ingredientId,
        after: { qty: body.qty, unitCost: body.unitCost },
      });

      return { ok: true, receiptId: receipt.id, movementId: movement.id };
    });
  }

  @Allow('STOREKEEPER')
  @Post('stock/adjust')
  async adjustStock(
    @Body(new ZodPipe(AdjustStockSchema)) body: z.infer<typeof AdjustStockSchema>,
    @Principal() principal: any,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const movement = await this.inventory.adjustStock(tx, {
        ingredientId: body.ingredientId,
        type: body.type,
        qty: new Decimal(body.qty),
        reason: body.reason,
        createdBy: principal.userId,
      });

      // Audit
      await this.audit.record(tx, {
        actorId: principal.userId,
        action: `${body.type}_STOCK`,
        entity: 'Ingredient',
        entityId: body.ingredientId,
        reason: body.reason,
        after: { qty: body.qty, type: body.type },
      });

      return { ok: true, movementId: movement.id };
    });
  }

  @Allow('STOREKEEPER', 'HEAD_CHEF', 'MANAGER')
  @Get('stock/levels')
  async stockLevels(@Query('ingredientId') ingredientId?: string) {
    const where = ingredientId ? { id: ingredientId } : {};
    const ingredients = await this.prisma.ingredient.findMany({
      where,
      orderBy: { name: 'asc' },
    });

    const results = await Promise.all(
      ingredients.map(async (i) => {
        const currentStock = await this.inventory.getCurrentStock(i.id);
        return {
          id: i.id,
          code: i.code,
          name: i.name,
          currentStock: currentStock.toNumber(),
          minStock: i.minStock.toNumber(),
          unit: i.unit,
          belowMin: currentStock.lessThan(i.minStock),
        };
      }),
    );

    return results;
  }
}
