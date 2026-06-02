import { PlaitElement, PlaitTheme, Viewport } from '@plait/core';

export type DrawnixDocument = {
  children: PlaitElement[];
  viewport?: Viewport | null;
  theme?: PlaitTheme | null;
};

export type SyncUser = {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
};

export type SyncSession = {
  token: string;
  user: SyncUser;
};

export type SyncDocumentResponse = {
  revision: number;
  updatedAt: string | null;
  updatedByDeviceId: string | null;
  data: DrawnixDocument;
};

export const EMPTY_DOCUMENT = (): DrawnixDocument => ({
  children: [],
  viewport: null,
  theme: null,
});

export const isEmptyDocument = (document: DrawnixDocument) => {
  return document.children.length === 0 && !document.viewport && !document.theme;
};
