import type { TableDto } from '@nhs/types';
import { Button, errorMessage, Modal, TABLE_STATUS_LABEL, TABLE_STATUS_STYLE } from '@nhs/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { usePos } from './context';
import { TablePanel } from './TablePanel';

export function TableMap({ tables }: { tables: TableDto[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [openByGuests, setOpenByGuests] = useState(false);
  const zones = [...new Set(tables.map((t) => t.zone))];
  const table = tables.find((t) => t.id === selected);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Legend />
        <Button onClick={() => setOpenByGuests(true)}>+ Mở bàn theo số khách</Button>
      </div>
      {zones.map((zone) => (
        <section key={zone}>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-500">{zone}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {tables
              .filter((t) => t.zone === zone)
              .map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSelected(t.id)}
                  className={`flex aspect-[4/3] flex-col items-start justify-between rounded-2xl border-2 p-3 text-left transition-transform hover:scale-[1.02] ${TABLE_STATUS_STYLE[t.status]}`}
                >
                  <span className="text-2xl font-bold">{t.code}</span>
                  <span className="text-xs">
                    {t.seats} ghế · {TABLE_STATUS_LABEL[t.status]}
                  </span>
                </button>
              ))}
          </div>
        </section>
      ))}
      {table && <TablePanel table={table} tables={tables} onClose={() => setSelected(null)} />}
      {openByGuests && (
        <OpenByGuests
          onClose={() => setOpenByGuests(false)}
          onOpened={(tableId) => {
            setOpenByGuests(false);
            setSelected(tableId);
          }}
        />
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {(Object.keys(TABLE_STATUS_LABEL) as (keyof typeof TABLE_STATUS_LABEL)[]).map((s) => (
        <span key={s} className={`rounded-full border px-2.5 py-1 font-medium ${TABLE_STATUS_STYLE[s]}`}>
          {TABLE_STATUS_LABEL[s]}
        </span>
      ))}
    </div>
  );
}

/** Nhập số khách → gợi ý bàn trống vừa đủ ghế → mở Dining Session. */
function OpenByGuests({ onClose, onOpened }: { onClose: () => void; onOpened: (tableId: string) => void }) {
  const { api, toast } = usePos();
  const qc = useQueryClient();
  const [guests, setGuests] = useState(2);
  const [suggestions, setSuggestions] = useState<{ id: string; code: string; seats: number; zone: string }[] | null>(null);

  async function suggest() {
    try {
      setSuggestions(await api.get(`/tables/suggest?guests=${guests}`));
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  async function open(tableId: string) {
    try {
      await api.post('/sessions', { tableId, guests });
      await qc.invalidateQueries({ queryKey: ['tables'] });
      onOpened(tableId);
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  return (
    <Modal title="Mở bàn theo số khách" onClose={onClose}>
      <div className="flex items-end gap-2">
        <label className="flex-1">
          <span className="text-sm font-medium">Số khách</span>
          <input type="number" min={1} max={100} className="mt-1 w-full rounded-xl border border-stone-300 px-3 py-2.5" value={guests} onChange={(e) => setGuests(Number(e.target.value))} />
        </label>
        <Button onClick={() => void suggest()} disabled={guests < 1}>
          Gợi ý bàn
        </Button>
      </div>
      {suggestions && (
        <div className="mt-4 space-y-2">
          {suggestions.length === 0 && <p className="text-sm text-stone-500">Không còn bàn trống đủ chỗ.</p>}
          {suggestions.map((s) => (
            <button key={s.id} onClick={() => void open(s.id)} className="flex w-full items-center justify-between rounded-xl border border-stone-200 px-4 py-3 hover:border-sen-400 hover:bg-sen-50">
              <span className="font-bold">{s.code}</span>
              <span className="text-sm text-stone-600">
                {s.seats} ghế · {s.zone}
              </span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
