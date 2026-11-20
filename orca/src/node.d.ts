// The few Node APIs the worker and the tests use. The typings `orca plugin types` writes
// leave Node out, and the plugin ships no node_modules, so they are declared here.
declare module 'node:fs/promises' {
  export type Dirent = { name: string; isDirectory(): boolean; isFile(): boolean }
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>
  export function readdir(path: string): Promise<string[]>
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function writeFile(path: string, data: string): Promise<void>
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>
  export function mkdtemp(prefix: string): Promise<string>
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  export function stat(path: string): Promise<{ size: number; mtimeMs: number; isFile(): boolean }>
}

declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function dirname(path: string): string
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string
}

declare const process: { env: Record<string, string | undefined> }
