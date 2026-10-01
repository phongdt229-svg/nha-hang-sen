import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Allow } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';

const RecipeSchema = z.object({ ingredients: z.array(z.object({ ingredientId: z.string().uuid(), qty: z.number().min(0.1), unit: z.string() })) });
const StockSchema = z.object({ ingredientId: z.string().uuid(), qty: z.number().min(0), reason: z.string().max(100) });

@Controller()
export class InventoryController {
  constructor(private readonly prisma: PrismaService) {}

  @Allow('STOREKEEPER', 'HEAD_CHEF', 'MANAGER')
  @Get('ingredients')
  async listIngredients() {
    return this.prisma.ingredient.findMany({ include: { stocks: { take: 1, orderBy: { createdAt: 'desc' } } }, orderBy: { name: 'asc' } });
  }

  @Allow('HEAD_CHEF', 'MANAGER')
  @Get('menu/:id/recipe')
  async getRecipe(@Param('id') menuItemId: string) {
    return this.prisma.menuItem.findUniqueOrThrow({ where: { id: menuItemId }, include: { recipeLines: { include: { ingredient: true } } } });
  }

  @Allow('HEAD_CHEF', 'MANAGER')
  @Post('menu/:id/recipe')
  async setRecipe(@Param('id') menuItemId: string, @Body(new ZodPipe(RecipeSchema)) body: z.infer<typeof RecipeSchema>) {
    await this.prisma.$transaction(async (tx) => {
      await tx.recipeLine.deleteMany({ where: { menuItemId } });
      await tx.recipeLine.createMany({ data: body.ingredients.map((i) => ({ menuItemId, ...i })) });
    });
    return { ok: true };
  }

  @Allow('STOREKEEPER')
  @Post('stock/adjust')
  async adjustStock(@Body(new ZodPipe(StockSchema)) body: z.infer<typeof StockSchema>) {
    return this.prisma.stockMovement.create({
      data: { ingredientId: body.ingredientId, type: 'ADJUSTED', qty: body.qty, note: body.reason },
    });
  }

  @Allow('STOREKEEPER', 'HEAD_CHEF', 'MANAGER')
  @Get('stock/levels')
  async stockLevels(@Query('ingredientId') ingredientId?: string) {
    const where = ingredientId ? { id: ingredientId } : {};
    const ingredients = await this.prisma.ingredient.findMany({ where, include: { stocks: { take: 1, orderBy: { createdAt: 'desc' } } } });
    return ingredients.map((i) => ({ id: i.id, name: i.name, currentStock: i.stocks[0]?.qty ?? 0, unit: i.stocks[0]?.unit ?? 'pcs' }));
  }
}
