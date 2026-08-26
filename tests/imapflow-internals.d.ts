// imapflow ships no types for its internals. The search compiler is the only
// way to assert what the server is actually asked, so declare just that.
declare module "imapflow/lib/search-compiler.js" {
  export type SearchToken = { type: string; value: string } | SearchToken[];
  export const searchCompiler: (connection: unknown, criteria: unknown) => SearchToken[];
}
