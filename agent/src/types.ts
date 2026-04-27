export interface Finding {
  id: string;
  url: string;
  title: string;
  domain: string;
  summary: string;
  category: string;
  subcategory?: string;
  whyBad: string;
  severity: 'low' | 'medium' | 'high';
  foundAt: string;
  researchQuery: string;
}

export interface FindingsStore {
  lastUpdated: string;
  totalFindings: number;
  findings: Finding[];
}

export interface RunState {
  lastRun: string;
  categoryIndex: number;
  seenUrls: string[];
}

export interface Category {
  key: string;
  name: string;
  description: string;
  researchPrompt: string;
}
