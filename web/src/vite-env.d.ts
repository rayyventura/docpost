/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_WS_URL?: string;
  readonly VITE_TOTAL_SUPPORTED_DESTINATIONS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
