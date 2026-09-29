import type { BillStatus, OrderItemStatus, SessionStatus, TableStatus, TicketStatus, TripStage } from './states';

export type Role = 'ADMIN' | 'MANAGER' | 'CASHIER' | 'WAITER' | 'KITCHEN' | 'HEAD_CHEF' | 'STOREKEEPER' | 'ACCOUNTANT';
export type DeviceKind = 'TABLET' | 'KDS' | 'PRINTER';
export type OrderSource = 'TABLET' | 'POS' | 'AI';
export type PaymentMethod = 'CASH' | 'QR' | 'CARD' | 'EWALLET';

export interface TableDto {
  id: string;
  code: string;
  seats: number;
  zone: string;
  status: TableStatus;
  sessionId: string | null;
}

export interface MenuCategoryDto {
  id: string;
  name: string;
  sort: number;
}

export interface MenuItemDto {
  id: string;
  code: string;
  name: string;
  categoryId: string;
  /** Giá niêm yết, đơn vị: đồng (số nguyên). */
  price: number;
  tags: string[];
  imageUrl: string | null;
  available: boolean;
  station: string;
  taxGroup: string;
}

export interface SessionDto {
  id: string;
  code: string;
  guests: number;
  status: SessionStatus;
  openedAt: string;
  tableIds: string[];
  tableCodes: string[];
}

export interface OrderItemDto {
  id: string;
  menuItemId: string;
  name: string;
  qty: number;
  note: string | null;
  unitPrice: number;
  status: OrderItemStatus;
  station: string;
}

export interface OrderDto {
  id: string;
  number: string;
  sessionId: string;
  source: OrderSource;
  total: number;
  createdAt: string;
  kitchenAcked: boolean;
  items: OrderItemDto[];
}

export interface KitchenTicketDto {
  id: string;
  orderId: string;
  orderNumber: string;
  station: string;
  status: TicketStatus;
  attempts: number;
  tableCodes: string[];
  createdAt: string;
  items: OrderItemDto[];
}

export interface CreateOrderRequest {
  items: { menuItemId: string; qty: number; note?: string }[];
}

export interface TaxBreakdownDto {
  taxGroup: string;
  rate: number;
  base: number;
  tax: number;
}

export interface BillLineDto {
  orderItemId: string;
  name: string;
  qty: number;
  unitPrice: number;
  discount: number;
  taxGroup: string;
  taxRate: number;
  amount: number;
}

export interface BillDto {
  id: string;
  number: string;
  sessionId: string;
  status: BillStatus;
  version: number;
  parentId: string | null;
  label: string | null;
  lines: BillLineDto[];
  subtotal: number;
  discount: number;
  taxes: TaxBreakdownDto[];
  totalTax: number;
  total: number;
  paid: number;
  refunded: number;
  /** Hóa đơn điện tử gốc của bill (sau khi thanh toán). */
  einvoice?: EInvoiceSummaryDto | null;
}

export type EInvoiceStatus = 'PENDING' | 'SENT' | 'ISSUED' | 'FAILED' | 'ADJUSTED' | 'REPLACED';
export type EInvoiceKind = 'ORIGINAL' | 'ADJUSTMENT' | 'REPLACEMENT';

export interface EInvoiceSummaryDto {
  id: string;
  status: EInvoiceStatus;
  number: string | null;
  series: string | null;
  lookupCode: string | null;
  lookupUrl: string | null;
  error: string | null;
}

export interface EInvoiceDto extends EInvoiceSummaryDto {
  billId: string;
  billNumber: string;
  kind: EInvoiceKind;
  provider: string;
  templateCode: string | null;
  taxAuthorityCode: string | null;
  issuedAt: string | null;
  businessDay: string | null;
  totalBase: number;
  totalTax: number;
  total: number;
  taxes: { rate: number; base: number; tax: number }[];
  buyer: BillBuyerDto | null;
  attempts: number;
  createdAt: string;
}

export interface BillBuyerDto {
  kind: 'PERSON' | 'COMPANY';
  taxCode: string | null;
  name: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
}

export type RobotVendor = 'SIMULATED' | 'MQTT' | 'ORIONSTAR' | 'MANUAL';
export type RobotState = 'IDLE' | 'BUSY' | 'CHARGING' | 'ERROR' | 'OFFLINE' | 'DISABLED';

export interface RobotDto {
  id: string;
  code: string;
  name: string;
  vendor: RobotVendor;
  state: RobotState;
  battery: number;
  location: string;
  error: string | null;
  lastSeenAt: string | null;
  tripId: string | null;
}

export interface TripDto {
  id: string;
  code: string;
  robotId: string | null;
  robotCode: string | null;
  sessionId: string;
  tableId: string;
  tableCode: string;
  stage: TripStage;
  failReason: string | null;
  createdAt: string;
  assignedAt: string | null;
  pickedUpAt: string | null;
  arrivedAt: string | null;
  deliveredAt: string | null;
  items: { id: string; name: string; qty: number; station: string; status: OrderItemStatus }[];
}

export interface ReadyGroupDto {
  sessionId: string;
  tableId: string | null;
  tableCode: string | null;
  oldestReadyAt: string;
  waitingSeconds: number;
  stillCooking: number;
  items: { id: string; name: string; qty: number; station: string; deliveryMode: 'ROBOT' | 'STAFF' }[];
}

/** Vị trí tức thời của robot, gửi qua WebSocket không lưu sổ (sự kiện "robot.telemetry"). */
export interface RobotTelemetry {
  robotId: string;
  code: string;
  battery: number;
  location: string;
  progress: number | null;
  tripCode: string | null;
  tableCode: string | null;
  stage: TripStage | null;
}
