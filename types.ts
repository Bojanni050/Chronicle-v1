export enum SourceType {
  CHATGPT = 'ChatGPT',
  CLAUDE = 'Claude',
  GEMINI = 'Gemini',
  QWEN = 'Qwen',
  LOCAL = 'Local LLM',
  OTHER = 'Other',
  MANUAL = 'Manual'
}

export enum ItemType {
  CHAT = 'chat',
  NOTE = 'note'
}

export enum Theme {
  LIGHT = 'light',
  DARK = 'dark',
  SYSTEM = 'system'
}

export enum AIProvider {
  GEMINI = 'Gemini',
  OPENAI = 'OpenAI',
  ANTHROPIC = 'Anthropic',
  MISTRAL = 'Mistral',
  LMSTUDIO = 'LM Studio'
}

/**
 * Manual link between two entries
 */
export interface Link {
  fromId: string;
  toId: string;
  type?: string;
  createdAt: number;
}

/**
 * Metadata tracking memory decay history
 */
export interface DecayMetadata {
  lastDecayRun?: number;
  decayHistory?: DecayHistoryEntry[];
}

export interface DecayHistoryEntry {
  timestamp: number;
  previousSalience: number;
  newSalience: number;
  hoursSinceAccess: number;
  modifiers?: DecayModifiers;
}

export interface DecayModifiers {
  ltpFactor: number;
  recallBoost: number;
  environmentalMultiplier: number;
  ebbinghausModifier: number;
}

export interface Fact {
  id: string;
  chatId: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  salience: number;
  validFrom: string;
  validTo?: string;
  createdAt: number;
  recallCount?: number;
  lastAccessedAt?: number;
  decayMetadata?: DecayMetadata;
}

/**
 * Fact zoals teruggegeven door de Gemini extractie (voor opslag)
 */
export interface ExtractedFact {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

/**
 * Core Entry in the Archive (can be a Chat or a Note)
 */
export interface ChatEntry {
  id: string;
  type: ItemType; // 'chat' or 'note'
  title: string;
  content: string;
  summary: string;
  tags: string[];
  source: string;
  createdAt: number;
  updatedAt: number;
  fileName?: string;
  embedding?: number[]; 
  assets?: string[]; // Base64 encoded images or URIs
  memory_type?: string;
  salience?: number; // nieuw — 0.0 tot 1.0
  recallCount?: number; // nieuw — hoe vaak opgeroepen
  lastAccessedAt?: number; // timestamp of last access for decay calculation
  decayMetadata?: DecayMetadata; // track decay history and parameters
}

/**
 * Light-weight version for search results and listings
 */
export type ChatSummary = Pick<ChatEntry, 'id' | 'title' | 'summary' | 'source' | 'createdAt' | 'type'>;

export interface Settings {
  theme: Theme;
  aiProvider: AIProvider;
  preferredModel: string;
  customEndpoint: string;
  relatedChatsLimit: number;
  availableModels: string[];
  userAvatar?: string;
  userName?: string;
  hasSeenDemo?: boolean;
  hindsightEnabled?: boolean;
  hindsightApiUrl?: string;
  hindsightBankId?: string;
  hindsightApiKey?: string;
}

export type ViewMode = 'dashboard' | 'archive' | 'mindmap' | 'search';

export interface AppState {
  chats: ChatEntry[];
  links: Link[];
  facts: Fact[];
  searchQuery: string;
  selectedSource: SourceType | 'All';
  selectedTags: string[];
  selectedType: ItemType | 'all';
  
  relatedTags: string[]; 
  isRightPanelOpen: boolean;

  viewMode: ViewMode;
  isUploading: boolean;
  isSettingsOpen: boolean;
  viewingChat: ChatEntry | null;
  settings: Settings;
  returnToMindMap: boolean;

  searchFilters: {
    sources: string[];
    dateStart: string;
    dateEnd: string;
    minLength: number;
    isSemantic: boolean;
    type: ItemType | 'all';
  };
}

export interface DateRange {
  start?: string;
  end?: string;
}

export interface SearchArchiveArgs {
  query: string;
}

export interface FilterChatsArgs {
  date_range?: DateRange;
  sources?: string[];
  tags?: string[];
  min_length?: number;
  type?: ItemType;
}
