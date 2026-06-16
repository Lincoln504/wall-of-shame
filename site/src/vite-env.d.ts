/// <reference types="vite/client" />

declare module 'hyphenation.en-us' {
  // tex-linebreak's `Patterns` shape; passed straight into createHyphenator.
  const patterns: { id: string; leftmin: number; rightmin: number; patterns: Record<string, string> };
  export default patterns;
}
