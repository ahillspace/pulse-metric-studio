import { create } from "zustand";

export type Notice = {
  id: number;
  tone: "success" | "error" | "warning" | "info";
  message: string;
};
interface Notices {
  notice: Notice | null;
  show: (tone: Notice["tone"], message: string) => void;
  dismiss: () => void;
}
export const useNotices = create<Notices>((set) => ({
  notice: null,
  show: (tone, message) => set({ notice: { id: Date.now(), tone, message } }),
  dismiss: () => set({ notice: null }),
}));

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
