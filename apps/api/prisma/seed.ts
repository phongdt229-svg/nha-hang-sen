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
  // Vị trí robot (MB-06) theo sa bàn demo A1 (docs/sa-ban-demo-robot-A1.pdf): vạch đôi ở BẾP = vị trí gốc (vạch 0),
  // vạch 1–4 = BÀN 1–4 (T01–T04), vạch 5 = TRẠM SẠC. mBot chỉ tới được các vạch này; robot giả lập tới được mọi bàn
  // (Robot Gateway tự sinh vòng chạy giả lập theo danh sách bàn). ORIONSTAR: tên điểm trên bản đồ LuckiBot (chờ vendor xác nhận).
  const fixed = [
    { code: 'KITCHEN_PASS_01', kind: 'KITCHEN_PASS', name: 'Điểm lấy món (bếp)', stop: 0, position: 'Bếp', sort: 0 },
    { code: 'ROBOT_HOME', kind: 'HOME', name: 'Vị trí gốc', stop: 0, position: 'Vị trí chờ', sort: 1 },
    { code: 'CHARGER_01', kind: 'CHARGER', name: 'Trạm sạc', stop: 5, position: 'Trạm sạc', sort: 999 },
  ] as const;
  for (const l of fixed) {
    const vendorMapping = { MAKEBLOCK: { stop: l.stop }, ORIONSTAR: { position: l.position } };
    await prisma.robotLocation.upsert({ where: { code: l.code }, update: { vendorMapping }, create: { code: l.code, kind: l.kind, name: l.name, sort: l.sort, vendorMapping } });
  }
  const allTables = await prisma.table.findMany({ orderBy: { code: 'asc' } });
  for (const [i, t] of allTables.entries()) {
    const n = Number(t.code.replace(/\D/g, ''));
    const vendorMapping = { ...(n >= 1 && n <= 4 ? { MAKEBLOCK: { stop: n } } : {}), ORIONSTAR: { position: `Bàn ${String(n).padStart(2, '0')}` } };
    await prisma.robotLocation.upsert({
      where: { code: `TABLE_${t.code}` },
      update: { vendorMapping, tableId: t.id },
      create: { code: `TABLE_${t.code}`, kind: 'TABLE', name: `Bàn ${t.code}`, tableId: t.id, sort: 10 + i, vendorMapping },
    });
  }

  // R01 = mBot v1 demo (MB-09) chạy qua robot bridge; R02, R03 = robot giả lập để demo không cần phần cứng.
  const mbotCaps = {
    supports_line_following: true,
    supports_basic_movement: true,
    supports_stop: true,
    supports_waypoint_demo: true,
    supports_return_home: true,
    supports_obstacle_demo: true,
    supports_customer_screen: false,
    supports_auto_docking: false,
    supports_elevator: false,
  };
  const simCaps = { ...mbotCaps, supports_line_following: false, supports_waypoint_demo: false };
  const robots = [
    { code: 'R01', name: 'mBot v1', vendor: 'MAKEBLOCK', model: 'MBOT_V1', externalId: 'mbot-01', capabilities: mbotCaps },
    { code: 'R02', name: 'Sen-02', vendor: 'SIMULATED', model: 'SIMULATOR', externalId: 'R02', capabilities: simCaps },
    { code: 'R03', name: 'Sen-03', vendor: 'SIMULATED', model: 'SIMULATOR', externalId: 'R03', capabilities: simCaps },
  ] as const;
  for (const r of robots) {
    const data = { name: r.name, vendor: r.vendor, model: r.model, externalId: r.externalId, capabilities: r.capabilities, telemetrySimulated: true };
    await prisma.robot.upsert({ where: { code: r.code }, update: data, create: { code: r.code, ...data } });
  }

  console.log(`Đã tạo dữ liệu mẫu. Tài khoản: ${users.map((u) => u[0]).join(', ')} / mật khẩu: ${password}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
