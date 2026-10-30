/** Text files imported with `with { type: 'text' }` (embedded in the compiled binary). */
declare module '*.md' {
  const text: string
  export default text
}
