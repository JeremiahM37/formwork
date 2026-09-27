import type { ApplicationBlocker } from "./application-state";
import type {Outcome} from "./engine";
export interface Job {
  company?: string;
  title?: string;
  description?: string;
  manual?: boolean;
}
export interface StyleFlag {
  name: string;
  fix?: string;
  found?: string[];
}
export interface Draft {
  id: string;
  question: string;
  text: string;
  company?: string;
  role?: string;
  note?: string;
  tells?: StyleFlag[];
  frameId?: number;
  autoApprove?: boolean;
}
export interface Receipt {
  blocked?: ApplicationBlocker;
  actions?: ActionReceipt[];
  company?: string;
  filled?: number;
  fields?: number;
  frameId?: number;
  hiddenOnly?: boolean;
  hiddenFields?: number;
  history?: { saved: number; existing: number; issues: string[] };
  failed?: string[];
  corrected?: string[];
  review?: { label: string; reason: string }[];
  missingRequired?: string[];
  drafts?: Draft[];
  mapError?: string;
  error?: string;
  contextWarning?: string;
  autoApprove?: boolean;
}
export interface ActionReceipt {
  id: string;
  action: 'fill' | 'attach';
  state: 'verified' | 'unconfirmed' | 'not_attempted';
  verification: 'local_file_bytes' | 'settled_control_value';
}
export interface FillResult {
  ok: boolean;
  reason?: string;
  error?: string;
  company?: string;
  title?: string;
}
export interface Analysis {
  error?: string;
  versions?: { id: number; name: string }[];
  fit: {
    coverage: number | null;
    matched: { skill: string; evidence: string }[];
    missing: { skill: string; posting: string }[];
    explanation: string;
  };
  sponsorshipExcerpts?: string[];
  note?: string;
}
export interface Messages {
  getJobContext: { request: Record<string, never>; response: Job };
  saveJobContext: { request: Job; response: { error?: string } };
  fanout: {
    request: Record<string, never>;
    response: { frameId: number; summary?: Receipt }[];
  };
  reveal: { request: Record<string, never>; response: { revealed: boolean; reason?: string; blocked?: ApplicationBlocker } };
  styleReview: { request: { text: string }; response: { tells?: StyleFlag[] } };
  redraft: {
    request: {
      question: string;
      company?: string;
      role?: string;
      previous: string;
      instruction: string;
    };
    response: {
      text?: string;
      tells?: StyleFlag[];
      error?: string;
      note?: string;
      contextWarning?: string;
    };
  };
  approveInFrame: {
    request: { frameId: number; id: string; text: string };
    response: FillResult;
  };
  approve: {
    request: {
      question: string;
      answer: string;
      company?: string;
      role?: string;
      companySpecific: boolean;
    };
    response: unknown;
  };
  analyzePosting: {
    request: Job & { version_id?: number };
    response: Analysis;
  };
  savePosting: { request: Job; response: { error?: string } };
}
export type Send = <K extends keyof Messages>(
  type: K,
  payload: Messages[K]["request"],
) => Promise<Messages[K]["response"]>;
export interface Runtime {
  applicationBlocker?: () => ApplicationBlocker | null;
  runFrame: () => Promise<Receipt | null>;
  fillApproved: (id: string, text: string) => Promise<FillResult>;
  scrape: () => { schema: Job };
  readJobPosting?: () => Job | null;
  onProgress?: (text: string) => void;
  refreshLocalReport?: () => void;
  _listenerError?: string;
  _last?: Outcome;
  _panel?: { toggle: () => void };
}
export interface Bridge {
  ns: Runtime;
  send: Send;
  summarize: (value: Outcome | undefined | null) => Receipt | null;
}
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
