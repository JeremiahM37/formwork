import type { Job, Receipt, Runtime, StyleFlag } from "./types";
export interface Field {
  id: string;
  label: string;
  type: string;
  section?: string;
  history?: unknown;
}
export interface Schema extends Job {
  fields: Field[];
}
export interface Scraped {
  schema: Schema;
  registry: HTMLElement[][];
}
interface Plan {
  error?: string;
  fills: Record<string, unknown>;
  review: { id: string; label: string; reason: string }[];
  dropped: { reason: string }[];
  missingRequired: Field[];
  staged: {
    id: string;
    question: string;
    text: string;
    note?: string;
    tells?: StyleFlag[];
  }[];
  documents?: Record<string, { name: string; dataUrl: string; type?: string }>;
  hints?: Record<string, unknown>;
  jobContext?: Job;
  mapError?: string;
  contextWarning?: string;
  autoApprove?: boolean;
}
interface Report {
  receipts?: Receipt['actions'];
  filled: string[];
  failed: { reason: string }[];
  history?: Receipt["history"];
}
export interface Outcome {
  scraped: Scraped;
  result: Partial<Plan>;
  report: Report | null;
}
export interface Engine extends Runtime {
  _initialized?: boolean;
  _uiVersion?: string;
  _options?: Record<string, unknown>;
  _last?: Outcome;
  revealForm?: () => Promise<boolean>;
  visibleFieldCount?: () => number;
  findOpener: () => HTMLElement | null;
  hiddenFieldCount: () => number;
  lazyFormOpener?: () => HTMLElement | null;
  scrape: () => Scraped;
  scrapeFull: () => Promise<Scraped>;
  fillHistory?: (
    send: (type: string, payload: unknown) => Promise<unknown>,
  ) => Promise<Receipt["history"]>;
  historyEditorProtected?: (element: HTMLElement | undefined) => boolean;
  fill: (
    fills: Record<string, unknown>,
    schema: Schema,
    registry: HTMLElement[][],
    options: {
      review: string[];
      files?: Record<string, File>;
      hints?: Record<string, unknown>;
      keepExisting?: boolean;
    },
  ) => Promise<Report>;
}
export type { Plan, Report };
