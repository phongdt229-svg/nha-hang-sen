import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventsService } from '../events/events.service';
import { AuditService } from '../common/audit.service';
import { z } from 'zod';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class InventoryService {
  constructor(
    private prisma: PrismaService,
    private events: EventsService,
    private audit: AuditService,
  ) {}

  async createIngredient(data: {
    code: string;
    name: string;
    group: string;
    unit: string;
    minStock?: number;
    trackLots?: boolean;
  }) {
    return this.prisma.ingredient.create({
      data: {
        code: data.code,
        name: data.name,
        group: data.group,
        unit: data.unit,
        minStock: data.minStock ? new Decimal(data.minStock) : new Decimal(0),
        trackLots: data.trackLots ?? false,
      },
    });
  }

  async listIngredients() {
    return this.prisma.ingredient.findMany({
      include: {
        stocks: {
          take: 1,
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async getIngredient(id: string) {
    const ingredient = await this.prisma.ingredient.findUniqueOrThrow({
      where: { id },
    });
    return ingredient;
  }

  async getCurrentStock(ingredientId: string): Promise<Decimal> {
    const result = await this.prisma.stockMovement.aggregate({
      where: { ingredientId },
      _sum: { qty: true },
    });
    return result._sum.qty ?? new Decimal(0);
  }

  /// Nhập kho từ phiếu nhập
  async receiveStock(
    tx: any,
    data: {
      ingredientId: string;
      qty: Decimal;
      unitCost: Decimal;
      lotNumber?: string;
      expiresAt?: Date;
      warehouse?: string;
      refId: string; /// GoodsReceipt.id
      createdBy: string;
    },
  ) {
    const ingredient = await tx.ingredient.findUniqueOrThrow({
      where: { id: data.ingredientId },
    });

    // Ghi chuyển động stock
    const movement = await tx.stockMovement.create({
      data: {
        ingredientId: data.ingredientId,
        type: 'NHẬP',
        qty: data.qty,
        unit: ingredient.unit,
        unitCost: data.unitCost,
        lotNumber: data.lotNumber,
        warehouse: data.warehouse ?? 'MAIN',
        refType: 'GoodsReceipt',
        refId: data.refId,
        createdBy: data.createdBy,
      },
    });

    // Emit event
    await this.events.append(tx, 'stock.received', 'Ingredient', data.ingredientId, {
      qty: data.qty.toString(),
      unitCost: data.unitCost.toString(),
      lotNumber: data.lotNumber,
      refId: data.refId,
    });

    return movement;
  }

  /// Trừ kho khi order item chuyển sang PREPARING
  async deductStockForPreparation(
    tx: any,
    data: {
      menuItemId: string;
      qty: number;
      orderItemId: string;
      createdBy: string;
    },
  ) {
    // Lấy công thức món
    const recipeLines = await tx.recipeLine.findMany({
      where: { menuItemId: data.menuItemId },
      include: { ingredient: true },
    });

    if (recipeLines.length === 0) {
      console.warn(`⚠️ No recipe found for menu item ${data.menuItemId} - skipping stock deduction. TODO: seed default recipes.`);
      return;
    }

    for (const line of recipeLines) {
      const qtyToDeduct = new Decimal(data.qty).times(line.qty).times(
        new Decimal(1).plus(line.wastePercent.dividedBy(100)),
      );

      // Kiểm tra stock đủ không
      const currentStock = await this.getCurrentStock(line.ingredientId);
      if (currentStock.lessThan(qtyToDeduct)) {
        throw new BadRequestException(
          `Insufficient stock for ingredient ${line.ingredient.name}. Need ${qtyToDeduct}, have ${currentStock}`,
        );
      }

      // Ghi chuyển động stock (FEFO: lô sắp hết hạn trước)
      // Đơn giản: lấy unit_cost từ movement gần nhất
      const lastMovement = await tx.stockMovement.findFirst({
        where: { ingredientId: line.ingredientId, type: 'NHẬP' },
        orderBy: { createdAt: 'desc' },
      });

      await tx.stockMovement.create({
        data: {
          ingredientId: line.ingredientId,
          type: 'BÁN',
          qty: qtyToDeduct.negated(),
          unit: line.ingredient.unit,
          unitCost: lastMovement?.unitCost ?? new Decimal(0),
          warehouse: 'MAIN',
          refType: 'OrderItem',
          refId: data.orderItemId,
          createdBy: data.createdBy,
        },
      });

      // Emit event
      await this.events.append(tx, 'stock.consumed', 'OrderItem', data.orderItemId, {
        ingredientId: line.ingredientId,
        qty: qtyToDeduct.toString(),
      });
    }
  }

  /// Điều chỉnh kho (hủy, chuyển, etc.)
  async adjustStock(
    tx: any,
    data: {
      ingredientId: string;
      type: 'HỦY' | 'CHUYỂN' | 'ĐIỀU_CHỈNH';
      qty: Decimal;
      reason?: string;
      createdBy: string;
    },
  ) {
    const ingredient = await tx.ingredient.findUniqueOrThrow({
      where: { id: data.ingredientId },
    });

    const movement = await tx.stockMovement.create({
      data: {
        ingredientId: data.ingredientId,
        type: data.type,
        qty: data.type === 'HỦY' ? data.qty.negated() : data.qty,
        unit: ingredient.unit,
        warehouse: 'MAIN',
        note: data.reason,
        createdBy: data.createdBy,
      },
    });

    return movement;
  }

  /// Tính lại available status dựa trên stock
  async recomputeMenuAvailability(tx: any, ingredientId: string) {
    // Tìm tất cả menu item dùng ingredient này
    const recipeLines = await tx.recipeLine.findMany({
      where: { ingredientId },
      include: { menuItem: true },
    });

    for (const line of recipeLines) {
      const currentStock = await this.getCurrentStock(line.ingredientId);
      // Tính số phần có thể làm được từ stock này
      const portionsAvailable = currentStock.dividedBy(line.qty);

      const shouldBeAvailable = portionsAvailable.isPositive();
      const menuItem = line.menuItem;

      if (!shouldBeAvailable && menuItem.available) {
        // Set available = false và emit event
        await tx.menuItem.update({
          where: { id: line.menuItemId },
          data: { available: false },
        });
        await this.events.append(tx, 'menu.soldout', 'MenuItem', line.menuItemId, {
          reason: `Ingredient ${line.ingredient.name} insufficient`,
        });
      } else if (shouldBeAvailable && !menuItem.available) {
        // Set available = true và emit event
        await tx.menuItem.update({
          where: { id: line.menuItemId },
          data: { available: true },
        });
        await this.events.append(tx, 'menu.available', 'MenuItem', line.menuItemId, {
          reason: `Stock replenished`,
        });
      }
    }
  }
}
