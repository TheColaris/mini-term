export type PtyWriteFn = (ptyId: number, data: string) => Promise<unknown>;

interface PendingWrite {
  data: string;
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

interface PtyWriteState {
  pending: PendingWrite[];
  writing: boolean;
}

export function createPtyWriteQueue(writeFn: PtyWriteFn) {
  const states = new Map<number, PtyWriteState>();

  async function drain(ptyId: number, state: PtyWriteState): Promise<void> {
    while (state.pending.length > 0) {
      const batch = state.pending;
      state.pending = [];
      const data = batch.map((item) => item.data).join('');

      try {
        await writeFn(ptyId, data);
        batch.forEach((item) => item.resolve());
      } catch (error) {
        batch.forEach((item) => item.reject(error));
      }
    }

    state.writing = false;
    if (state.pending.length === 0) {
      states.delete(ptyId);
      return;
    }

    state.writing = true;
    void drain(ptyId, state);
  }

  return (ptyId: number, data: string): Promise<void> => {
    let state = states.get(ptyId);
    if (!state) {
      state = { pending: [], writing: false };
      states.set(ptyId, state);
    }

    const promise = new Promise<void>((resolve, reject) => {
      state.pending.push({ data, resolve, reject });
    });

    if (!state.writing) {
      state.writing = true;
      void drain(ptyId, state);
    }

    return promise;
  };
}
