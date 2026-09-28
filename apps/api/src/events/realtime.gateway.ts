import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { rooms as R, type DomainEvent } from '@nhs/types';
import type { Server, Socket } from 'socket.io';
import { AuthGuard } from '../auth/auth.guard';
import type { Principal } from '../auth/principal';
import { BROADCAST } from './events.service';

/** Phòng mà một principal được phép nghe (mục 8). */
export function roomsOf(p: Principal, requestedStation?: string): string[] {
  if (p.kind === 'device') {
    if (p.deviceKind === 'TABLET' && p.tableId) return [R.table(p.tableId)];
    if (p.deviceKind === 'KDS' && p.station) return [R.kitchen(p.station)];
    return [];
  }
  if (p.role === 'KITCHEN') return requestedStation ? [R.kitchen(requestedStation)] : [];
  return [R.pos, R.dashboard, R.dispatch];
}

@WebSocketGateway({ cors: { origin: true } })
export class RealtimeGateway implements OnGatewayConnection {
  @WebSocketServer() server: Server;

  constructor(private readonly auth: AuthGuard) {}

  async handleConnection(socket: Socket) {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) throw new Error('missing token');
      const principal = await this.auth.verify(token);
      const station = socket.handshake.auth?.station as string | undefined;
      socket.data.principal = principal;
      await socket.join(roomsOf(principal, station));
    } catch {
      socket.emit('error', { message: 'Unauthorized' });
      socket.disconnect(true);
    }
  }

  /** Dữ liệu tức thời (vị trí robot): gửi "volatile", không lưu sổ, mất gói cũng không sao. */
  emitVolatile(name: string, payload: unknown, rooms: string[]) {
    this.server?.to(rooms).volatile.emit(name, payload);
  }

  emit(event: DomainEvent, rooms: string[]) {
    if (!this.server) return;
    if (rooms.includes(BROADCAST)) this.server.emit('event', event);
    else if (rooms.length > 0) this.server.to(rooms).emit('event', event);
  }
}
