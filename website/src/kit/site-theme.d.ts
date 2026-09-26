interface Window {
  siteTheme: {
    readonly palette: string;
    readonly mode: 'light' | 'dark';
    set(palette?: string | null, mode?: 'light' | 'dark'): void;
  };
}
