import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/password';

const prisma = new PrismaClient();

const STATIONS = { hot: 'BEP_NONG', cold: 'BEP_LANH', bar: 'QUAY_BAR' };

const MENU: Record<string, [code: string, name: string, price: number, station: string, taxGroup: string, tags: string[]][]> = {
  'Khai vị': [
    ['KV01', 'Gỏi cuốn tôm thịt', 55_000, STATIONS.cold, 'FOOD', []],
    ['KV02', 'Nem rán Hà Nội', 65_000, STATIONS.hot, 'FOOD', []],
    ['KV03', 'Gỏi ngó sen', 75_000, STATIONS.cold, 'FOOD', ['chay']],
  ],
  'Món chính': [
    ['MC01', 'Phở bò tái', 65_000, STATIONS.hot, 'FOOD', []],
    ['MC02', 'Bún chả Hà Nội', 60_000, STATIONS.hot, 'FOOD', []],
    ['MC03', 'Cơm sen hấp lá', 95_000, STATIONS.hot, 'FOOD', ['dac-biet']],
    ['MC04', 'Cá kho tộ', 120_000, STATIONS.hot, 'FOOD', []],
    ['MC05', 'Đậu hũ sốt nấm', 70_000, STATIONS.hot, 'FOOD', ['chay']],
    ['MC06', 'Mì xào hải sản cay', 85_000, STATIONS.hot, 'FOOD', ['cay']],
  ],
  'Tráng miệng': [
    ['TM01', 'Chè hạt sen long nhãn', 35_000, STATIONS.cold, 'FOOD', ['chay']],
    ['TM02', 'Bánh flan', 25_000, STATIONS.cold, 'FOOD', ['tre-em']],
  ],
  'Đồ uống': [
    ['DU01', 'Trà sen', 30_000, STATIONS.bar, 'FOOD', []],
    ['DU02', 'Nước ép cam', 40_000, STATIONS.bar, 'FOOD', ['tre-em']],
    ['DU03', 'Cà phê sữa đá', 30_000, STATIONS.bar, 'FOOD', []],
  ],
  'Bia rượu': [
    ['BR01', 'Bia Hà Nội', 25_000, STATIONS.bar, 'ALCOHOL', []],
    ['BR02', 'Rượu sen (ly)', 45_000, STATIONS.bar, 'ALCOHOL', []],
  ],
};

async function main() {
  const password = process.env.SEED_PASSWORD ?? 'sen123';
  const users = [
    ['admin', 'Chủ quán', 'ADMIN'],
    ['quanly', 'Quản lý ca', 'MANAGER'],
    ['thungan', 'Thu ngân', 'CASHIER'],
    ['phucvu', 'Phục vụ', 'WAITER'],
    ['bep', 'Bếp', 'KITCHEN'],
    ['ketoan', 'Kế toán', 'ACCOUNTANT'],
  ] as const;
  for (const [username, name, role] of users) {
    await prisma.user.upsert({ where: { username }, update: {}, create: { username, name, role, passwordHash: hashPassword(password) } });
  }

  const zones = ['Tầng 1', 'Tầng 1', 'Tầng 1', 'Tầng 1', 'Tầng 2', 'Tầng 2', 'Tầng 2', 'Tầng 2', 'Sân vườn', 'Sân vườn', 'Sân vườn', 'Sân vườn'];
  const seats = [2, 2, 4, 4, 4, 6, 6, 8, 4, 4, 6, 10];
  // SEED_TABLES=40 tạo đủ quy mô mục 17.2 cho kiểm thử tải; bàn thêm xếp ở Tầng 3.
  const tableCount = Math.max(zones.length, Number(process.env.SEED_TABLES ?? zones.length));
  for (let i = 0; i < tableCount; i++) {
    const code = `T${String(i + 1).padStart(2, '0')}`;
    await prisma.table.upsert({ where: { code }, update: {}, create: { code, seats: seats[i] ?? 4, zone: zones[i] ?? 'Tầng 3' } });
  }

  let sort = 0;
  for (const [categoryName, items] of Object.entries(MENU)) {
    const category =
      (await prisma.menuCategory.findFirst({ where: { name: categoryName } })) ??
      (await prisma.menuCategory.create({ data: { name: categoryName, sort } }));
    sort++;
    for (const [i, [code, name, price, station, taxGroup, tags]] of items.entries()) {
      await prisma.menuItem.upsert({ where: { code }, update: {}, create: { code, name, price, station, taxGroup, tags, categoryId: category.id, sort: i } });
    }
  }

  // Thuế suất có ngày hiệu lực: đồ ăn/uống giảm còn 8% từ 01/07/2025 đến 31/12/2026; bia rượu (chịu TTĐB) giữ 10%.
  if ((await prisma.taxRate.count()) === 0) {
    await prisma.taxRate.createMany({
      data: [
        { taxGroup: 'FOOD', rateBp: 1000, validFrom: new Date('2000-01-01'), validTo: new Date('2025-06-30'), note: 'Thuế suất thông thường' },
        { taxGroup: 'FOOD', rateBp: 800, validFrom: new Date('2025-07-01'), validTo: new Date('2026-12-31'), note: 'Giảm thuế GTGT 2%' },
        { taxGroup: 'FOOD', rateBp: 1000, validFrom: new Date('2027-01-01'), validTo: null, note: 'Hết giảm thuế — kế toán xác nhận lại' },
        { taxGroup: 'ALCOHOL', rateBp: 1000, validFrom: new Date('2000-01-01'), validTo: null, note: 'Hàng chịu thuế TTĐB, không được giảm' },
      ],
    });
  }
  // Robot giả lập để trình diễn không cần phần cứng; robot thật thêm trên màn hình điều phối.
  const robots = [
    ['R01', 'Sen-01', 'SIMULATED'],
    ['R02', 'Sen-02', 'SIMULATED'],
    ['R03', 'Sen-03', 'SIMULATED'],
  ] as const;
  for (const [code, name, vendor] of robots) {
    await prisma.robot.upsert({ where: { code }, update: {}, create: { code, name, vendor, externalId: code, model: 'Giả lập' } });
  }

  console.log(`Đã tạo dữ liệu mẫu. Tài khoản: ${users.map((u) => u[0]).join(', ')} / mật khẩu: ${password}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
