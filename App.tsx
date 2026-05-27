
import React, { useState, useEffect, useMemo } from 'react';
import { ChatEntry, SourceType, AppState, Settings, Theme, AIProvider, ViewMode, ItemType, Link } from './types';
import { Sidebar } from './components/Sidebar';
import { SearchIcon, PlusIcon, DatabaseIcon, SettingsIcon, XIcon, ChartIcon, NetworkIcon, ActivityIcon, BoltIcon } from './components/Icons';
import { UploadModal } from './components/UploadModal';
import { ChatViewer } from './components/ChatViewer';
import { SettingsModal } from './components/SettingsModal';
import { AnalyticsDashboard } from './components/AnalyticsDashboard';
import { RightSidebar } from './components/RightSidebar';
import { AdvancedSearch } from './components/AdvancedSearch';
import { ExtractedFact } from './types';
import { retainMemory, recallMemories, ensureBank, updateConfig, getConfig } from './services/hindsightService';

const STORAGE_KEY = 'chronicle_chats_v1';
const LINKS_KEY = 'chronicle_links_v1';
const SETTINGS_KEY = 'chronicle_settings_v1';

declare global {
  interface Window {
    chronicleAPI: any;
    electronAPI?: {
      isNative: boolean;
      getAppPath: () => Promise<string>;
      getExecutablePath: () => Promise<string>;
      saveDatabase: (data: any) => Promise<boolean>;
      loadDatabase: () => Promise<any>;
      addLink: (fromId: string, toId: string, type?: string) => Promise<boolean>;
      removeLink: (fromId: string, toId: string) => Promise<boolean>;
      loadLinks: () => Promise<Link[]>;
      exportChats: (chats: any[], format: string) => Promise<{success: boolean, path?: string, error?: string, cancelled?: boolean}>;
      importChats: (existingIds: string[]) => Promise<{success: boolean, chats: any[], skipped: number, error?: string, cancelled?: boolean}>;
      sendNotification: (title: string, body: string) => void;
      platform: string;
      boostSalience: (chatId: string) => Promise<boolean>;
      saveFacts: (chatId: string, facts: ExtractedFact[]) => Promise<boolean>;
      loadFacts: (chatId: string) => Promise<any[]>;
    };
  }
}

const DEFAULT_SETTINGS: Settings = {
  theme: Theme.LIGHT,
  aiProvider: AIProvider.GEMINI,
  preferredModel: 'gemini-3-flash-preview',
  customEndpoint: 'http://localhost:1234/v1/chat/completions',
  relatedChatsLimit: 9,
  availableModels: [],
  userAvatar: undefined,
  userName: ''
};
