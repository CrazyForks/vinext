// Ambient declaration for the cloudflare:workers virtual module provided by
// @cloudflare/vite-plugin in dev and by the workerd runtime in production.
declare module 'cloudflare:workers' {
  const env: Record<string, unknown>
  export { env }
}
