declare module 'xpath-html' {
  const xhtml: {
    fromPageSource(html: string): unknown
    fromNode(node: unknown): unknown
  }
  export = xhtml
}

declare module 'xpath' {
  export function select(xpath: string, node: unknown, single?: boolean): unknown[]
  export function evaluate(
    xpath: string,
    node: unknown,
    resolver: unknown,
    type: number,
    result: unknown
  ): unknown
  export function useNamespaces(map: Record<string, string>): void
}
